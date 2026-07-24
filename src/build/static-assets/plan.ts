import {createHash} from "node:crypto";
import type {Hash} from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type {BigIntStats} from "node:fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  isValidatedProjectCatalog,
  validateProjectMedia,
} from "../../domain/content/index.js";
import type {
  ProjectCatalog,
  ProjectMediaSourceInput,
  ProjectPreviewAsset,
} from "../../domain/content/index.js";
import {
  revalidateBuildContext,
} from "../site-config/index.js";
import type {BuildContext} from "../site-config/index.js";
import {StaticAssetError, failStaticAsset} from "./errors.js";
import {isDeepFrozenPlainData} from "./plain-data.js";
import {
  assertDirectory,
  compareUtf8,
  isPathWithin,
  MAX_PROJECT_MEDIA_BYTES,
  MAX_SOURCE_DEPTH,
  MAX_SOURCE_FILES,
  MAX_SOURCE_PATH_BYTES,
  MAX_SOURCE_TOTAL_BYTES,
  MAX_STATIC_PUBLIC_FILE_BYTES,
  MAX_UNPUBLISHED_CONTENT_TOKEN_BYTES,
  MAX_UNPUBLISHED_FILE_BYTES,
  readAsciiDirectoryNames,
  readPrivateFileSnapshot,
  scanBuildTree,
  sha256,
} from "./file-safety.js";
import {
  decodeStaticPublicRegistry,
} from "./registry.js";
import type {StaticPublicRegistryEntry} from "./registry.js";
import type {
  PrepareStaticAssetPlanInput,
  StaticAssetExcludedFile,
  StaticAssetManifest,
  StaticAssetManifestFile,
  StaticAssetMode,
  StaticAssetPlan,
  StaticPublicAssetRole,
  UnpublishedAssetSnapshotInput,
} from "./types.js";

const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PROJECT_FILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.webp$/u;
const STATIC_DIRECTORY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STATIC_FILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/u;
const PREPARE_INPUT_KEYS = Object.freeze([
  "mode",
  "repositoryRoot",
  "catalog",
  "staticPublicRegistry",
  "unpublishedAssets",
]);
const PREPARE_INPUT_REQUIRED_KEYS = Object.freeze([
  "mode",
  "repositoryRoot",
  "catalog",
  "staticPublicRegistry",
]);
const REGISTRY_DOCUMENT_KEYS = Object.freeze(["sourcePath", "value"]);
const UNPUBLISHED_ENTRY_KEYS = Object.freeze([
  "sourcePath",
  "publicPath",
  "bytes",
]);
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)?.get;

interface StaticAssetPlanPrivateState {
  readonly inputDigest: string;
  assertInputsCurrent(): void;
}

const staticAssetPlanPrivateStates = new WeakMap<
  object,
  StaticAssetPlanPrivateState
>();

interface PrivateAllowedFile {
  readonly manifest: StaticAssetManifestFile;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

interface AllowedFileEvidence {
  readonly manifest: StaticAssetManifestFile;
  readonly byteLength: number;
  readonly sha256: string;
}

interface PrivateExcludedFile {
  readonly manifest: StaticAssetExcludedFile;
  readonly byteLength: number;
  readonly projectId?: string;
  readonly pathTokens: readonly Uint8Array[];
  readonly contentTokens: readonly Uint8Array[];
  readonly sha256: string;
}

interface ExcludedFileCandidate {
  readonly manifest: StaticAssetExcludedFile;
  readonly bytes: Uint8Array;
  readonly projectId?: string;
  readonly sha256: string;
}

interface StaticAssetInputDigestRecord {
  readonly disposition: "allowed" | "excluded";
  readonly kind: StaticAssetManifestFile["kind"] | StaticAssetExcludedFile["kind"];
  readonly sourcePath: string;
  readonly targetPath: string | null;
  readonly publicUrl: string | null;
  readonly role: StaticPublicAssetRole | null;
  readonly projectId: string | null;
  readonly byteLength: number;
  readonly sha256: string;
}

interface ProjectScanResult {
  readonly sources: readonly ProjectMediaSourceInput[];
  readonly snapshots: ReadonlyMap<string, Uint8Array>;
  readonly directories: readonly string[];
}

interface StaticPublicFileSnapshot {
  readonly entry: StaticPublicRegistryEntry;
  readonly bytes: Uint8Array;
}

interface StaticPublicScanResult {
  readonly snapshots: readonly StaticPublicFileSnapshot[];
  readonly directories: readonly string[];
}

interface GenericUnpublishedSnapshot {
  readonly sourcePath: string;
  readonly publicUrl: string | null;
  readonly bytes: Uint8Array;
}

function snapshotExactDataFields(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  code: string,
  message: string,
  sourcePath: string,
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      failStaticAsset(code, message, {sourcePath});
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set(allowedKeys);
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || !allowed.has(key)) {
        failStaticAsset(code, message, {sourcePath});
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
      ) {
        failStaticAsset(code, message, {sourcePath});
      }
      snapshot[key] = descriptor.value;
    }
    if (requiredKeys.some((key) => !Object.hasOwn(snapshot, key))) {
      failStaticAsset(code, message, {sourcePath});
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof StaticAssetError) throw error;
    failStaticAsset(code, message, {cause: error, sourcePath});
  }
}

function snapshotPrepareInput(value: unknown): PrepareStaticAssetPlanInput {
  const fields = snapshotExactDataFields(
    value,
    PREPARE_INPUT_KEYS,
    PREPARE_INPUT_REQUIRED_KEYS,
    "STATIC_ASSET_INPUT",
    "静态素材计划输入必须是精确的普通数据字段集合。",
    "site-assets",
  );
  const registryFields = snapshotExactDataFields(
    fields.staticPublicRegistry,
    REGISTRY_DOCUMENT_KEYS,
    REGISTRY_DOCUMENT_KEYS,
    "STATIC_ASSET_PUBLIC_REGISTRY",
    "始终公开素材注册表输入必须是精确的普通数据字段集合。",
    "docs/contracts/static-public-assets.json",
  );
  return Object.freeze({
    mode: fields.mode,
    repositoryRoot: fields.repositoryRoot,
    catalog: fields.catalog,
    staticPublicRegistry: Object.freeze({
      sourcePath: registryFields.sourcePath,
      value: registryFields.value,
    }),
    ...(Object.hasOwn(fields, "unpublishedAssets")
      ? {unpublishedAssets: fields.unpublishedAssets}
      : {}),
  }) as unknown as PrepareStaticAssetPlanInput;
}

function snapshotDenseArray(
  value: unknown,
  maximumLength: number,
  code: string,
  message: string,
  sourcePath: string,
): readonly unknown[] {
  try {
    if (!Array.isArray(value)) {
      failStaticAsset(code, message, {sourcePath});
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
    const lengthDescriptor = descriptors.length;
    const lengthValue = lengthDescriptor?.value as unknown;
    if (
      lengthDescriptor === undefined
      || lengthDescriptor.enumerable
      || !Object.hasOwn(lengthDescriptor, "value")
      || !Number.isSafeInteger(lengthValue)
      || (lengthValue as number) < 0
      || (lengthValue as number) > maximumLength
    ) {
      failStaticAsset(code, message, {sourcePath});
    }
    const length = lengthValue as number;
    if (Reflect.ownKeys(descriptors).length !== length + 1) {
      failStaticAsset(code, message, {sourcePath});
    }
    const snapshot = new Array<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
      ) {
        failStaticAsset(code, message, {sourcePath});
      }
      snapshot[index] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof StaticAssetError) throw error;
    failStaticAsset(code, message, {cause: error, sourcePath});
  }
}

function assertValidatedCatalog(catalog: ProjectCatalog): void {
  if (
    !isDeepFrozenPlainData(catalog)
    || !isValidatedProjectCatalog(catalog)
  ) {
    failStaticAsset(
      "STATIC_ASSET_CATALOG",
      "静态素材计划只接受已验证并深冻结的项目目录。",
      {sourcePath: "docs/contracts/projects.json"},
    );
  }
}

function assertCanonicalRepositoryRoot(repositoryRoot: string): string {
  if (
    typeof repositoryRoot !== "string"
    || !isAbsolute(repositoryRoot)
    || resolve(repositoryRoot) !== repositoryRoot
  ) {
    failStaticAsset(
      "STATIC_ASSET_REPOSITORY_ROOT",
      "仓库根必须是规范绝对路径。",
      {sourcePath: "site-assets"},
    );
  }
  const realRoot = assertDirectory(repositoryRoot, "site-assets");
  if (realRoot !== repositoryRoot) {
    failStaticAsset(
      "STATIC_ASSET_REPOSITORY_ROOT",
      "仓库根不能通过符号或别名路径进入。",
      {sourcePath: "site-assets"},
    );
  }
  return realRoot;
}

function stat(path: string, sourcePath: string): BigIntStats {
  try {
    return lstatSync(path, {bigint: true});
  } catch (error) {
    failStaticAsset(
      "STATIC_ASSET_IO",
      "静态素材文件系统状态读取失败。",
      {cause: error, sourcePath},
    );
  }
}

function optionalStat(path: string, sourcePath: string): BigIntStats | undefined {
  try {
    return lstatSync(path, {bigint: true});
  } catch (error) {
    if (
      error !== null
      && typeof error === "object"
      && Object.hasOwn(error, "code")
      && (error as Readonly<{code?: unknown}>).code === "ENOENT"
    ) return undefined;
    failStaticAsset(
      "STATIC_ASSET_IO",
      "静态素材文件系统状态读取失败。",
      {cause: error, sourcePath},
    );
  }
}

function currentUidMatches(metadata: BigIntStats): boolean {
  return typeof process.getuid !== "function"
    || metadata.uid === BigInt(process.getuid());
}

function safeRealPathWithin(path: string, realRoot: string): boolean {
  try {
    return isPathWithin(realRoot, realpathSync(path));
  } catch {
    return false;
  }
}

function assertSourceDirectory(
  path: string,
  sourcePath: string,
  realParent: string,
): string {
  const realDirectory = assertDirectory(path, sourcePath);
  if (!isPathWithin(realParent, realDirectory)) {
    failStaticAsset(
      "STATIC_ASSET_SOURCE_ESCAPE",
      "素材目录真实路径逃逸预期根目录。",
      {sourcePath},
    );
  }
  return realDirectory;
}

function scanProjectMedia(
  repositoryRoot: string,
  catalog: ProjectCatalog,
): ProjectScanResult {
  const assetRoot = resolve(repositoryRoot, "site-assets");
  const directories: string[] = [];
  if (optionalStat(assetRoot, "site-assets") === undefined) {
    return Object.freeze({
      sources: Object.freeze([]),
      snapshots: new Map(),
      directories: Object.freeze([]),
    });
  }
  const realAssetRoot = assertSourceDirectory(assetRoot, "site-assets", repositoryRoot);
  directories.push("site-assets");
  const assetEntries = readAsciiDirectoryNames(assetRoot, "site-assets");
  for (const entry of assetEntries) {
    if (entry !== "projects") {
      failStaticAsset(
        "STATIC_ASSET_SOURCE_PATH",
        "site-assets 当前只允许 projects 素材分区。",
        {sourcePath: `site-assets/${entry}`},
      );
    }
  }
  const projectsRoot = resolve(assetRoot, "projects");
  if (optionalStat(projectsRoot, "site-assets/projects") === undefined) {
    return Object.freeze({
      sources: Object.freeze([]),
      snapshots: new Map(),
      directories: Object.freeze(directories),
    });
  }
  const realProjectsRoot = assertSourceDirectory(
    projectsRoot,
    "site-assets/projects",
    realAssetRoot,
  );
  directories.push("site-assets/projects");
  const knownProjectIds = new Set(catalog.projects.map((project) => project.id));
  const sources: ProjectMediaSourceInput[] = [];
  const snapshots = new Map<string, Uint8Array>();
  let totalBytes = 0;
  let unownedSnapshot: Uint8Array | undefined;

  try {
    for (const projectId of readAsciiDirectoryNames(projectsRoot, "site-assets/projects")) {
      const projectSourcePath = `site-assets/projects/${projectId}`;
      if (!PROJECT_ID_PATTERN.test(projectId) || !knownProjectIds.has(projectId)) {
        failStaticAsset(
          "STATIC_ASSET_PROJECT_DIRECTORY",
          "项目素材目录必须精确对应已验证项目 ID。",
          {sourcePath: projectSourcePath},
        );
      }
      const projectDirectory = resolve(projectsRoot, projectId);
      const realProjectDirectory = assertSourceDirectory(
        projectDirectory,
        projectSourcePath,
        realProjectsRoot,
      );
      directories.push(projectSourcePath);
      const names = readAsciiDirectoryNames(projectDirectory, projectSourcePath);
      if (names.length === 0) {
        failStaticAsset(
          "STATIC_ASSET_EMPTY_DIRECTORY",
          "项目素材目录不能是未登记的空目录。",
          {sourcePath: projectSourcePath},
        );
      }
      for (const name of names) {
        const sourcePath = `${projectSourcePath}/${name}`;
        if (!PROJECT_FILE_PATTERN.test(name)) {
          failStaticAsset(
            "STATIC_ASSET_PROJECT_PATH",
            "项目素材叶子必须是 lowercase kebab-case WebP 文件。",
            {sourcePath},
          );
        }
        if (Buffer.byteLength(sourcePath, "utf8") > MAX_SOURCE_PATH_BYTES) {
          failStaticAsset(
            "STATIC_ASSET_SOURCE_PATH",
            "项目素材路径超过字节上限。",
            {sourcePath: projectSourcePath},
          );
        }
        if (sources.length >= MAX_SOURCE_FILES) {
          failStaticAsset(
            "STATIC_ASSET_SOURCE_COUNT",
            "项目素材候选数量超过上限。",
            {sourcePath: "site-assets/projects"},
          );
        }
        const absolutePath = resolve(projectDirectory, name);
        const metadata = stat(absolutePath, sourcePath);
        const isSymbolicLink = metadata.isSymbolicLink();
        const isRegularFile = metadata.isFile();
        const isRealPathWithinRoot = safeRealPathWithin(absolutePath, realAssetRoot);
        let bytes: Uint8Array | undefined;
        if (!isSymbolicLink && isRealPathWithinRoot && isRegularFile) {
          if (!currentUidMatches(metadata)) {
            failStaticAsset(
              "STATIC_ASSET_SOURCE_OWNER",
              "项目素材必须属于当前构建用户。",
              {sourcePath},
            );
          }
          unownedSnapshot = readPrivateFileSnapshot({
            absolutePath,
            realRoot: realProjectDirectory,
            sourcePath,
            maximumBytes: MAX_PROJECT_MEDIA_BYTES,
          });
          bytes = unownedSnapshot;
          snapshots.set(sourcePath, bytes);
          unownedSnapshot = undefined;
          totalBytes += bytes.byteLength;
          if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
            failStaticAsset(
              "STATIC_ASSET_SOURCE_TOTAL_SIZE",
              "项目素材私有快照总字节超过上限。",
              {sourcePath: "site-assets/projects"},
            );
          }
        }
        sources.push(Object.freeze({
          sourcePath,
          isSymbolicLink,
          isRealPathWithinRoot,
          isRegularFile,
          ...(bytes === undefined ? {} : {bytes}),
        }));
      }
    }
    sources.sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath));
    return Object.freeze({
      sources: Object.freeze(sources),
      snapshots,
      directories: Object.freeze(directories),
    });
  } catch (error) {
    unownedSnapshot?.fill(0);
    unownedSnapshot = undefined;
    for (const bytes of snapshots.values()) bytes.fill(0);
    snapshots.clear();
    sources.length = 0;
    throw error;
  }
}

function validateStaticPublicName(
  name: string,
  segments: readonly string[],
  isDirectory: boolean,
): void {
  const sourcePath = `static-public/${[...segments, name].join("/")}`;
  const isWellKnownRoot = segments.length === 0 && name === ".well-known";
  const isValid = isDirectory
    ? isWellKnownRoot || STATIC_DIRECTORY_PATTERN.test(name)
    : STATIC_FILE_PATTERN.test(name);
  if (
    !isValid
    || (name.startsWith(".") && !isWellKnownRoot)
    || [...segments, name].length > MAX_SOURCE_DEPTH
  ) {
    failStaticAsset(
      "STATIC_ASSET_PUBLIC_PATH",
      "始终公开素材目录含非法、隐藏或过深路径段。",
      {sourcePath: segments.length === 0 ? "static-public" : `static-public/${segments.join("/")}`},
    );
  }
  if (Buffer.byteLength(sourcePath, "utf8") > MAX_SOURCE_PATH_BYTES) {
    failStaticAsset(
      "STATIC_ASSET_SOURCE_PATH",
      "始终公开素材路径超过字节上限。",
      {sourcePath: segments.length === 0 ? "static-public" : `static-public/${segments.join("/")}`},
    );
  }
}

function scanStaticPublic(
  repositoryRoot: string,
  registry: readonly StaticPublicRegistryEntry[],
): StaticPublicScanResult {
  const staticRoot = resolve(repositoryRoot, "static-public");
  if (optionalStat(staticRoot, "static-public") === undefined) {
    if (registry.length !== 0) {
      failStaticAsset(
        "STATIC_ASSET_PUBLIC_MISSING",
        "始终公开素材注册表存在条目但源目录缺失。",
        {sourcePath: "static-public"},
      );
    }
    return Object.freeze({
      snapshots: Object.freeze([]),
      directories: Object.freeze([]),
    });
  }
  const realStaticRoot = assertSourceDirectory(
    staticRoot,
    "static-public",
    repositoryRoot,
  );
  const directories: string[] = ["static-public"];
  const discovered = new Map<string, string>();
  const walk = (directory: string, segments: readonly string[]): number => {
    let fileCount = 0;
    const parentPath = segments.length === 0
      ? "static-public"
      : `static-public/${segments.join("/")}`;
    for (const name of readAsciiDirectoryNames(directory, parentPath)) {
      const absolutePath = resolve(directory, name);
      const metadata = stat(absolutePath, parentPath);
      if (metadata.isSymbolicLink()) {
        failStaticAsset(
          "STATIC_ASSET_SOURCE_FILE_TYPE",
          "始终公开素材树不得包含符号链接。",
          {sourcePath: parentPath},
        );
      }
      if (metadata.isDirectory()) {
        validateStaticPublicName(name, segments, true);
        const sourcePath = `static-public/${[...segments, name].join("/")}`;
        const realDirectory = assertSourceDirectory(
          absolutePath,
          sourcePath,
          realStaticRoot,
        );
        directories.push(sourcePath);
        const nested = walk(realDirectory, [...segments, name]);
        if (nested === 0) {
          failStaticAsset(
            "STATIC_ASSET_EMPTY_DIRECTORY",
            "始终公开素材树不得包含空的嵌套目录。",
            {sourcePath: `static-public/${[...segments, name].join("/")}`},
          );
        }
        fileCount += nested;
        continue;
      }
      validateStaticPublicName(name, segments, false);
      if (!metadata.isFile() || metadata.nlink !== 1n) {
        failStaticAsset(
          metadata.isFile()
            ? "STATIC_ASSET_SOURCE_HARDLINK"
            : "STATIC_ASSET_SOURCE_FILE_TYPE",
          "始终公开素材叶子必须是单链接普通文件。",
          {sourcePath: `static-public/${[...segments, name].join("/")}`},
        );
      }
      const relativePath = [...segments, name].join("/");
      discovered.set(relativePath, absolutePath);
      fileCount += 1;
      if (discovered.size > MAX_SOURCE_FILES) {
        failStaticAsset(
          "STATIC_ASSET_SOURCE_COUNT",
          "始终公开素材文件数量超过上限。",
          {sourcePath: "static-public"},
        );
      }
    }
    return fileCount;
  };
  walk(realStaticRoot, []);

  const registeredPaths = new Set(registry.map((entry) => entry.sourcePath));
  for (const path of [...discovered.keys()].sort(compareUtf8)) {
    if (!registeredPaths.has(path)) {
      failStaticAsset(
        "STATIC_ASSET_PUBLIC_UNREGISTERED",
        "static-public 中存在未显式登记的文件。",
        {sourcePath: `static-public/${path}`},
      );
    }
  }
  for (const entry of registry) {
    if (!discovered.has(entry.sourcePath)) {
      failStaticAsset(
        "STATIC_ASSET_PUBLIC_MISSING",
        "始终公开素材登记指向缺失文件。",
        {sourcePath: `static-public/${entry.sourcePath}`},
      );
    }
  }

  const snapshots: StaticPublicFileSnapshot[] = [];
  let totalBytes = 0;
  let unownedSnapshot: Uint8Array | undefined;
  try {
    for (const entry of registry) {
      const absolutePath = discovered.get(entry.sourcePath);
      if (absolutePath === undefined) continue;
      unownedSnapshot = readPrivateFileSnapshot({
        absolutePath,
        realRoot: realStaticRoot,
        sourcePath: `static-public/${entry.sourcePath}`,
        maximumBytes: MAX_STATIC_PUBLIC_FILE_BYTES,
      });
      const bytes = unownedSnapshot;
      snapshots.push(Object.freeze({entry, bytes}));
      unownedSnapshot = undefined;
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
        failStaticAsset(
          "STATIC_ASSET_SOURCE_TOTAL_SIZE",
          "始终公开素材私有快照总字节超过上限。",
          {sourcePath: "static-public"},
        );
      }
    }
    return Object.freeze({
      snapshots: Object.freeze(snapshots),
      directories: Object.freeze(directories.sort(compareUtf8)),
    });
  } catch (error) {
    unownedSnapshot?.fill(0);
    unownedSnapshot = undefined;
    for (const snapshot of snapshots) snapshot.bytes.fill(0);
    snapshots.length = 0;
    throw error;
  }
}

function isSafeRepositoryPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_SOURCE_PATH_BYTES
    && !value.startsWith("/")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && value.split("/").every((segment) => (
      segment !== "" && segment !== "." && segment !== ".."
    ));
}

function isSafePublicUrl(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("/")
    && value !== "/"
    && Buffer.byteLength(value, "utf8") <= MAX_SOURCE_PATH_BYTES
    && !value.includes("\\")
    && !value.includes("//")
    && !/[?#%\s\u0000-\u001f\u007f-\u009f]/u.test(value)
    && value.slice(1).split("/").every((segment) => (
      segment !== "" && segment !== "." && segment !== ".."
    ));
}

function isContentAssetSourcePath(value: unknown): value is string {
  if (!isSafeRepositoryPath(value)) return false;
  const segments = value.split("/");
  if (
    segments.length < 5
    || segments[0] !== "site-content"
    || (segments[1] !== "projects" && segments[1] !== "writing")
    || !PROJECT_ID_PATTERN.test(segments[2] ?? "")
    || segments[3] !== "assets"
  ) return false;
  const assetSegments = segments.slice(4);
  const fileName = assetSegments.at(-1);
  return fileName !== undefined
    && STATIC_FILE_PATTERN.test(fileName)
    && assetSegments.slice(0, -1).every((segment) => (
      STATIC_DIRECTORY_PATTERN.test(segment)
    ));
}

function snapshotUint8Array(value: unknown, sourcePath: string): Uint8Array {
  let snapshot: Uint8Array | undefined;
  try {
    if (
      typeof TYPED_ARRAY_BYTE_LENGTH !== "function"
      || typeof TYPED_ARRAY_TAG !== "function"
      || !ArrayBuffer.isView(value)
      || Reflect.apply(TYPED_ARRAY_TAG, value, []) !== "Uint8Array"
    ) throw new TypeError("invalid Uint8Array brand");
    const length = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []) as unknown;
    if (
      !Number.isSafeInteger(length)
      || (length as number) < 0
      || (length as number) > MAX_UNPUBLISHED_FILE_BYTES
    ) {
      failStaticAsset(
        "STATIC_ASSET_UNPUBLISHED_SIZE",
        "未发布素材私有快照长度超过上限。",
        {sourcePath},
      );
    }
    snapshot = new Uint8Array(length as number);
    Uint8Array.prototype.set.call(snapshot, value as Uint8Array);
    const result = snapshot;
    snapshot = undefined;
    return result;
  } catch (error) {
    snapshot?.fill(0);
    snapshot = undefined;
    if (error instanceof StaticAssetError) throw error;
    failStaticAsset(
      "STATIC_ASSET_UNPUBLISHED_BYTES",
      "未发布素材必须提供可安全复制的真实 Uint8Array。",
      {cause: error, sourcePath},
    );
  }
}

function snapshotGenericUnpublished(
  inputs: readonly UnpublishedAssetSnapshotInput[] | undefined,
): readonly GenericUnpublishedSnapshot[] {
  if (inputs === undefined) return Object.freeze([]);
  const inputSnapshots = snapshotDenseArray(
    inputs,
    MAX_SOURCE_FILES,
    "STATIC_ASSET_UNPUBLISHED_INPUT",
    "未发布素材快照集合必须是无稀疏、accessor 或额外字段的受控数组。",
    "site-content",
  );
  const snapshots: GenericUnpublishedSnapshot[] = [];
  const sourcePaths = new Set<string>();
  let totalBytes = 0;
  let unownedSnapshot: Uint8Array | undefined;
  try {
    for (const input of inputSnapshots) {
      const fields = snapshotExactDataFields(
        input,
        UNPUBLISHED_ENTRY_KEYS,
        UNPUBLISHED_ENTRY_KEYS,
        "STATIC_ASSET_UNPUBLISHED_INPUT",
        "未发布素材快照条目必须是精确的普通数据字段集合。",
        "site-content",
      );
      if (
        !isContentAssetSourcePath(fields.sourcePath)
        || (fields.publicPath !== null && !isSafePublicUrl(fields.publicPath))
      ) {
        failStaticAsset(
          "STATIC_ASSET_UNPUBLISHED_INPUT",
          "未发布正文素材路径或公开路径不合法。",
          {sourcePath: "site-content"},
        );
      }
      const sourcePath = fields.sourcePath;
      const publicPath = fields.publicPath as string | null;
      const foldedSource = sourcePath.toLocaleLowerCase("en-US");
      if (sourcePaths.has(foldedSource)) {
        failStaticAsset(
          "STATIC_ASSET_UNPUBLISHED_DUPLICATE",
          "未发布正文素材存在重复或大小写冲突源路径。",
          {sourcePath},
        );
      }
      sourcePaths.add(foldedSource);
      unownedSnapshot = snapshotUint8Array(fields.bytes, sourcePath);
      const bytes = unownedSnapshot;
      snapshots.push(Object.freeze({
        sourcePath,
        publicUrl: publicPath,
        bytes,
      }));
      unownedSnapshot = undefined;
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
        failStaticAsset(
          "STATIC_ASSET_SOURCE_TOTAL_SIZE",
          "未发布正文素材私有快照总字节超过上限。",
          {sourcePath: "site-content"},
        );
      }
    }
    snapshots.sort((left, right) => compareUtf8(left.sourcePath, right.sourcePath));
    return Object.freeze(snapshots);
  } catch (error) {
    unownedSnapshot?.fill(0);
    unownedSnapshot = undefined;
    for (const snapshot of snapshots) snapshot.bytes.fill(0);
    snapshots.length = 0;
    sourcePaths.clear();
    throw error;
  }
}

function assertNoTargetConflicts(files: readonly PrivateAllowedFile[]): void {
  const byTarget = [...files].sort((left, right) => (
    compareUtf8(left.manifest.targetPath, right.manifest.targetPath)
  ));
  const folded = new Map<string, string>();
  for (const file of byTarget) {
    const path = file.manifest.targetPath;
    const lower = path.toLocaleLowerCase("en-US");
    const previous = folded.get(lower);
    if (previous !== undefined) {
      failStaticAsset(
        previous === path
          ? "STATIC_ASSET_TARGET_DUPLICATE"
          : "STATIC_ASSET_TARGET_CASE_CONFLICT",
        "静态白名单目标存在重复或大小写冲突。",
        {sourcePath: file.manifest.sourcePath},
      );
    }
    folded.set(lower, path);
  }
  for (let index = 0; index < byTarget.length; index += 1) {
    const path = byTarget[index].manifest.targetPath;
    for (let candidate = index + 1; candidate < byTarget.length; candidate += 1) {
      const next = byTarget[candidate].manifest.targetPath;
      if (next.startsWith(`${path}/`)) {
        failStaticAsset(
          "STATIC_ASSET_TARGET_PREFIX_CONFLICT",
          "静态白名单目标存在文件与目录前缀冲突。",
          {sourcePath: byTarget[candidate].manifest.sourcePath},
        );
      }
      if (!next.startsWith(path)) break;
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function updateDigestBytes(hash: Hash, bytes: Uint8Array): void {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function updateDigestString(hash: Hash, value: string): void {
  updateDigestBytes(hash, Buffer.from(value, "utf8"));
}

function updateDigestField(hash: Hash, name: string, value: string): void {
  updateDigestString(hash, name);
  updateDigestString(hash, value);
}

function updateNullableDigestField(
  hash: Hash,
  name: string,
  value: string | null,
): void {
  updateDigestString(hash, name);
  hash.update(Uint8Array.of(value === null ? 0 : 1));
  if (value !== null) updateDigestString(hash, value);
}

function compareNullableUtf8(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : -1;
  return right === null ? 1 : compareUtf8(left, right);
}

function staticAssetInputDigest(
  mode: StaticAssetMode,
  allowed: readonly PrivateAllowedFile[],
  excluded: readonly PrivateExcludedFile[],
): string {
  const records: StaticAssetInputDigestRecord[] = [
    ...allowed.map((file): StaticAssetInputDigestRecord => Object.freeze({
      disposition: "allowed",
      kind: file.manifest.kind,
      sourcePath: file.manifest.sourcePath,
      targetPath: file.manifest.targetPath,
      publicUrl: file.manifest.publicUrl,
      role: file.manifest.kind === "static-public" ? file.manifest.role : null,
      projectId: file.manifest.kind === "project-preview"
        ? file.manifest.projectId
        : null,
      byteLength: file.bytes.byteLength,
      sha256: file.sha256,
    })),
    ...excluded.map((file): StaticAssetInputDigestRecord => Object.freeze({
      disposition: "excluded",
      kind: file.manifest.kind,
      sourcePath: file.manifest.sourcePath,
      targetPath: null,
      publicUrl: file.manifest.publicUrl,
      role: null,
      projectId: file.projectId ?? null,
      byteLength: file.byteLength,
      sha256: file.sha256,
    })),
  ];
  records.sort((left, right) => (
    compareUtf8(left.sourcePath, right.sourcePath)
    || compareNullableUtf8(left.targetPath, right.targetPath)
    || compareUtf8(left.disposition, right.disposition)
    || compareUtf8(left.kind, right.kind)
  ));

  const hash = createHash("sha256");
  updateDigestString(hash, "axial-muse-static-asset-input-v1");
  updateDigestField(hash, "mode", mode);
  updateDigestField(hash, "record-count", String(records.length));
  for (const record of records) {
    updateDigestString(hash, "record");
    updateDigestField(hash, "disposition", record.disposition);
    updateDigestField(hash, "kind", record.kind);
    updateDigestField(hash, "source-path", record.sourcePath);
    updateNullableDigestField(hash, "target-path", record.targetPath);
    updateNullableDigestField(hash, "public-url", record.publicUrl);
    updateNullableDigestField(hash, "role", record.role);
    updateNullableDigestField(hash, "project-id", record.projectId);
    updateDigestField(hash, "byte-length", String(record.byteLength));
    updateDigestField(hash, "sha256", record.sha256);
  }
  return hash.digest("hex");
}

function staticPhysicalSourceDigest(
  media: ProjectScanResult,
  publicResult: StaticPublicScanResult,
): string {
  const hash = createHash("sha256");
  updateDigestString(hash, "axial-muse-static-physical-input-v1");
  updateDigestField(
    hash,
    "project-directory-count",
    String(media.directories.length),
  );
  for (const sourcePath of media.directories) {
    updateDigestField(hash, "project-directory", sourcePath);
  }
  const mediaFiles = [...media.snapshots.entries()].sort((left, right) => (
    compareUtf8(left[0], right[0])
  ));
  updateDigestField(hash, "project-file-count", String(mediaFiles.length));
  for (const [sourcePath, bytes] of mediaFiles) {
    updateDigestField(hash, "project-source-path", sourcePath);
    updateDigestField(hash, "project-byte-length", String(bytes.byteLength));
    updateDigestField(hash, "project-sha256", sha256(bytes));
  }
  updateDigestField(
    hash,
    "static-public-directory-count",
    String(publicResult.directories.length),
  );
  for (const sourcePath of publicResult.directories) {
    updateDigestField(hash, "static-public-directory", sourcePath);
  }
  updateDigestField(
    hash,
    "static-public-file-count",
    String(publicResult.snapshots.length),
  );
  for (const {entry, bytes} of publicResult.snapshots) {
    updateDigestField(
      hash,
      "static-public-source-path",
      `static-public/${entry.sourcePath}`,
    );
    updateDigestField(hash, "static-public-role", entry.role);
    updateDigestField(hash, "static-public-byte-length", String(bytes.byteLength));
    updateDigestField(hash, "static-public-sha256", sha256(bytes));
  }
  return hash.digest("hex");
}

function createStaticInputsCurrentAssertion(input: Readonly<{
  repositoryRoot: string;
  catalog: ProjectCatalog;
  registry: readonly StaticPublicRegistryEntry[];
  expectedPhysicalDigest: string;
}>): () => void {
  return (): void => {
    let media: ProjectScanResult | undefined;
    let publicResult: StaticPublicScanResult | undefined;
    let operationError: unknown;
    try {
      media = scanProjectMedia(input.repositoryRoot, input.catalog);
      const mediaResult = validateProjectMedia({
        catalog: input.catalog,
        sources: media.sources,
      });
      if (!mediaResult.ok) {
        throw new TypeError("project media currentness validation failed");
      }
      publicResult = scanStaticPublic(input.repositoryRoot, input.registry);
      if (
        staticPhysicalSourceDigest(media, publicResult)
        !== input.expectedPhysicalDigest
      ) {
        throw new TypeError("static physical input digest changed");
      }
    } catch (error) {
      operationError = error;
    } finally {
      if (media !== undefined) {
        for (const bytes of media.snapshots.values()) bytes.fill(0);
      }
      if (publicResult !== undefined) {
        for (const snapshot of publicResult.snapshots) snapshot.bytes.fill(0);
      }
    }
    if (operationError !== undefined) {
      failStaticAsset(
        "STATIC_ASSET_SOURCE_DRIFT",
        "构建临界点的物理静态素材输入已发生漂移。",
        {cause: operationError, sourcePath: "site-assets"},
      );
    }
  };
}

function projectById(catalog: ProjectCatalog): ReadonlyMap<string, ProjectCatalog["projects"][number]> {
  return new Map(catalog.projects.map((project) => [project.id, project]));
}

function sourceSnapshotForPreview(
  preview: ProjectPreviewAsset,
  snapshots: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const repositoryPath = `site-assets/${preview.sourcePath}`;
  const bytes = snapshots.get(repositoryPath);
  if (bytes === undefined) {
    failStaticAsset(
      "STATIC_ASSET_PRIVATE_SNAPSHOT",
      "已验证项目预览缺少同次读取的私有字节快照。",
      {sourcePath: repositoryPath},
    );
  }
  return bytes;
}

function assertCombinedSnapshotTotal(
  mediaSnapshots: ReadonlyMap<string, Uint8Array>,
  publicSnapshots: readonly StaticPublicFileSnapshot[],
  genericUnpublished: readonly GenericUnpublishedSnapshot[],
): void {
  let totalBytes = 0;
  for (const bytes of mediaSnapshots.values()) totalBytes += bytes.byteLength;
  for (const snapshot of publicSnapshots) totalBytes += snapshot.bytes.byteLength;
  for (const snapshot of genericUnpublished) totalBytes += snapshot.bytes.byteLength;
  if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
    failStaticAsset(
      "STATIC_ASSET_SOURCE_TOTAL_SIZE",
      "本次静态素材计划的全部私有快照超过总字节上限。",
      {sourcePath: "site-assets"},
    );
  }
}

function createContentLeakTokens(bytes: Uint8Array): readonly Uint8Array[] {
  if (bytes.byteLength === 0) return Object.freeze([]);
  const tokens: Uint8Array[] = [];
  const rawLength = Math.min(bytes.byteLength, MAX_UNPUBLISHED_CONTENT_TOKEN_BYTES);
  tokens.push(bytes.slice(0, rawLength));
  const wholeBase64Length = 4 * Math.ceil(bytes.byteLength / 3);
  const base64SourceLength = wholeBase64Length <= MAX_UNPUBLISHED_CONTENT_TOKEN_BYTES
    ? bytes.byteLength
    : Math.floor(MAX_UNPUBLISHED_CONTENT_TOKEN_BYTES / 4) * 3;
  tokens.push(Buffer.from(
    Buffer.from(bytes.subarray(0, base64SourceLength)).toString("base64"),
    "ascii",
  ));
  return Object.freeze(tokens);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function uniqueLeakTokens(tokens: readonly Uint8Array[]): readonly Uint8Array[] {
  const unique: Uint8Array[] = [];
  const buckets = new Map<string, Uint8Array[]>();
  for (const token of tokens) {
    const identity = `${token.byteLength}:${sha256(token)}`;
    const bucket = buckets.get(identity);
    if (bucket?.some((candidate) => sameBytes(candidate, token)) === true) continue;
    unique.push(token);
    if (bucket === undefined) buckets.set(identity, [token]);
    else bucket.push(token);
  }
  return Object.freeze(unique);
}

function createPrivateFiles(
  mode: StaticAssetMode,
  catalog: ProjectCatalog,
  previews: readonly ProjectPreviewAsset[],
  mediaSnapshots: ReadonlyMap<string, Uint8Array>,
  publicSnapshots: readonly StaticPublicFileSnapshot[],
  genericUnpublished: readonly GenericUnpublishedSnapshot[],
): Readonly<{
  allowed: readonly PrivateAllowedFile[];
  excluded: readonly PrivateExcludedFile[];
}> {
  const allowed: PrivateAllowedFile[] = publicSnapshots.map(({entry, bytes}) => Object.freeze({
    manifest: Object.freeze({
      kind: "static-public" as const,
      sourcePath: `static-public/${entry.sourcePath}`,
      targetPath: entry.sourcePath,
      publicUrl: `/${entry.sourcePath}`,
      role: entry.role,
    }),
    bytes,
    sha256: sha256(bytes),
  }));
  const excludedCandidates: ExcludedFileCandidate[] = genericUnpublished.map((snapshot) => Object.freeze({
    manifest: Object.freeze({
      kind: "content-asset" as const,
      sourcePath: snapshot.sourcePath,
      publicUrl: snapshot.publicUrl,
    }),
    bytes: snapshot.bytes,
    sha256: sha256(snapshot.bytes),
  }));
  const projects = projectById(catalog);
  for (const preview of previews) {
    const project = projects.get(preview.projectId);
    if (project === undefined) {
      failStaticAsset(
        "STATIC_ASSET_CATALOG",
        "媒体投影引用了目录中不存在的项目。",
        {sourcePath: "docs/contracts/projects.json"},
      );
    }
    const bytes = sourceSnapshotForPreview(preview, mediaSnapshots);
    const sourcePath = `site-assets/${preview.sourcePath}`;
    const isPublished = ["published", "archived"].includes(project.publicationStatus);
    if (mode === "preview" || isPublished) {
      allowed.push(Object.freeze({
        manifest: Object.freeze({
          kind: "project-preview" as const,
          sourcePath,
          targetPath: `assets/${preview.sourcePath}`,
          publicUrl: preview.publicUrl,
          projectId: preview.projectId,
        }),
        bytes,
        sha256: sha256(bytes),
      }));
    } else {
      excludedCandidates.push(Object.freeze({
        manifest: Object.freeze({
          kind: "project-preview" as const,
          sourcePath,
          publicUrl: preview.publicUrl,
        }),
        bytes,
        projectId: preview.projectId,
        sha256: sha256(bytes),
      }));
    }
  }
  allowed.sort((left, right) => compareUtf8(
    left.manifest.targetPath,
    right.manifest.targetPath,
  ));
  excludedCandidates.sort((left, right) => compareUtf8(
    left.manifest.sourcePath,
    right.manifest.sourcePath,
  ));
  assertNoTargetConflicts(allowed);

  const projectHashes = new Set(
    previews.map((preview) => sha256(sourceSnapshotForPreview(preview, mediaSnapshots))),
  );
  const articleHashes = new Set(genericUnpublished.map(({bytes}) => sha256(bytes)));
  if ([...projectHashes].some((hash) => articleHashes.has(hash))) {
    failStaticAsset(
      "STATIC_ASSET_SOURCE_BYTE_DUPLICATE",
      "项目媒体与未发布正文素材不得共享同字节内容。",
      {sourcePath: "site-assets"},
    );
  }
  for (const file of allowed) {
    if (
      file.manifest.kind === "static-public"
      && (projectHashes.has(file.sha256) || articleHashes.has(file.sha256))
    ) {
      failStaticAsset(
        "STATIC_ASSET_PUBLIC_BYTE_DUPLICATE",
        "始终公开素材与项目或未发布正文素材字节重复。",
        {sourcePath: file.manifest.sourcePath},
      );
    }
  }
  if (mode === "production") {
    const allowedHashes = new Set(allowed.map((file) => file.sha256));
    if (excludedCandidates.some((file) => allowedHashes.has(file.sha256))) {
      failStaticAsset(
        "STATIC_ASSET_VISIBILITY_CONFLICT",
        "公开与未发布素材共享字节，无法建立生产泄漏闭包。",
        {sourcePath: "site-assets"},
      );
    }
  }
  const excluded: readonly PrivateExcludedFile[] = Object.freeze(
    excludedCandidates.map((file) => Object.freeze({
      manifest: file.manifest,
      byteLength: file.bytes.byteLength,
      ...(file.projectId === undefined ? {} : {projectId: file.projectId}),
      pathTokens: Object.freeze([
        Buffer.from(file.manifest.sourcePath, "utf8"),
        ...(file.manifest.publicUrl === null
          ? []
          : [Buffer.from(file.manifest.publicUrl, "utf8")]),
      ]),
      contentTokens: createContentLeakTokens(file.bytes),
      sha256: file.sha256,
    })),
  );
  const retainedBytes = new Set(allowed.map((file) => file.bytes));
  for (const bytes of mediaSnapshots.values()) {
    if (!retainedBytes.has(bytes)) bytes.fill(0);
  }
  for (const snapshot of genericUnpublished) snapshot.bytes.fill(0);
  return Object.freeze({
    allowed: Object.freeze(allowed),
    excluded,
  });
}

function assertEmptyStaticDirectory(buildContext: BuildContext): void {
  const entries = readdirSync(buildContext.staticDirectory);
  if (entries.length !== 0) {
    failStaticAsset(
      "STATIC_ASSET_TARGET_NOT_EMPTY",
      "静态白名单目标目录必须为空。",
      {sourcePath: "build-context/static"},
    );
  }
}

function assertWrittenFile(path: string, byteLength: number, sourcePath: string): void {
  const metadata = stat(path, sourcePath);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1n
    || metadata.size !== BigInt(byteLength)
    || (metadata.mode & 0o777n) !== 0o600n
    || !currentUidMatches(metadata)
  ) {
    failStaticAsset(
      "STATIC_ASSET_TARGET_FILE",
      "写入后的静态白名单文件身份、权限或大小不合法。",
      {sourcePath},
    );
  }
}

interface StaticDirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
}

function captureStaticDirectoryIdentity(
  buildContext: BuildContext,
): StaticDirectoryIdentity {
  const metadata = stat(buildContext.staticDirectory, "build-context/static");
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
    mode: metadata.mode,
  });
}

function hasSameStaticDirectoryIdentity(
  metadata: BigIntStats,
  identity: StaticDirectoryIdentity,
): boolean {
  return metadata.isDirectory()
    && !metadata.isSymbolicLink()
    && metadata.dev === identity.dev
    && metadata.ino === identity.ino
    && metadata.uid === identity.uid
    && metadata.mode === identity.mode;
}

function cleanupStaticDirectory(
  buildContext: BuildContext,
  identity: StaticDirectoryIdentity,
): void {
  try {
    const current = lstatSync(buildContext.staticDirectory, {bigint: true});
    if (
      !hasSameStaticDirectoryIdentity(current, identity)
      || realpathSync(buildContext.staticDirectory) !== buildContext.staticDirectory
    ) {
      failStaticAsset(
        "STATIC_ASSET_CLEANUP_UNCERTAIN",
        "静态白名单目标身份漂移，拒绝递归删除未知目录。",
        {sourcePath: "build-context/static"},
      );
    }
    rmSync(buildContext.staticDirectory, {recursive: true, force: false});
    mkdirSync(buildContext.staticDirectory, {mode: 0o700});
    chmodSync(buildContext.staticDirectory, 0o700);
    revalidateBuildContext(buildContext);
  } catch (error) {
    if (error instanceof StaticAssetError) throw error;
    failStaticAsset(
      "STATIC_ASSET_CLEANUP_UNCERTAIN",
      "静态白名单失败后的候选清理或空目录恢复失败。",
      {cause: error, sourcePath: "build-context/static"},
    );
  }
}

function assertMaterializedTree(
  buildContext: BuildContext,
  allowed: readonly PrivateAllowedFile[],
): void {
  const evidence = scanBuildTree(buildContext.staticDirectory, [], [], []);
  const expected = new Map(allowed.map((file) => [file.manifest.targetPath, file]));
  if (
    evidence.files.length !== expected.size
    || evidence.files.some((file) => {
      const candidate = expected.get(file.relativePath);
      return candidate === undefined
        || candidate.bytes.byteLength !== file.byteLength
        || candidate.sha256 !== file.sha256;
    })
  ) {
    failStaticAsset(
      "STATIC_ASSET_TARGET_SET",
      "物化后的临时静态树与计划白名单不一致。",
      {sourcePath: "build-context/static"},
    );
  }
}

function isManagedStaticPublicBuildPath(path: string): boolean {
  return path === "robots.txt"
    || /^favicon\.[^/]+$/u.test(path)
    || path.startsWith(".well-known/")
    || path.startsWith("assets/brand/");
}

class PreparedStaticAssetPlan implements StaticAssetPlan {
  readonly manifest: StaticAssetManifest;
  readonly #mode: StaticAssetMode;
  readonly #allowed: readonly AllowedFileEvidence[];
  readonly #excluded: readonly PrivateExcludedFile[];
  #pendingFiles: readonly PrivateAllowedFile[];
  #materialized = false;
  #consumed = false;
  #disposed = false;

  constructor(
    mode: StaticAssetMode,
    allowed: readonly PrivateAllowedFile[],
    excluded: readonly PrivateExcludedFile[],
    assertInputsCurrent: () => void,
  ) {
    this.#mode = mode;
    staticAssetPlanPrivateStates.set(
      this,
      Object.freeze({
        inputDigest: staticAssetInputDigest(mode, allowed, excluded),
        assertInputsCurrent,
      }),
    );
    this.#allowed = Object.freeze(allowed.map((file) => Object.freeze({
      manifest: file.manifest,
      byteLength: file.bytes.byteLength,
      sha256: file.sha256,
    })));
    this.#excluded = excluded;
    this.#pendingFiles = allowed;
    this.manifest = deepFreeze({
      mode,
      files: allowed.map((file) => ({...file.manifest})),
      excludedFiles: excluded.map((file) => ({...file.manifest})),
    });
    Object.freeze(this);
  }

  #discardPendingBytes(): void {
    for (const file of this.#pendingFiles) file.bytes.fill(0);
    this.#pendingFiles = Object.freeze([]);
  }

  #discardExcludedTokens(): void {
    for (const file of this.#excluded) {
      for (const token of file.pathTokens) token.fill(0);
      for (const token of file.contentTokens) token.fill(0);
    }
  }

  materialize(buildContext: BuildContext): StaticAssetManifest {
    if (this.#consumed) {
      failStaticAsset(
        "STATIC_ASSET_PLAN_CONSUMED",
        "静态素材计划只能物化一次。",
        {sourcePath: "build-context/static"},
      );
    }
    this.#consumed = true;
    let operationError: unknown;
    let verifiedContext: BuildContext | undefined;
    let staticIdentity: StaticDirectoryIdentity | undefined;
    let materializationStarted = false;
    try {
      verifiedContext = revalidateBuildContext(buildContext);
      if (verifiedContext.mode !== this.#mode) {
        failStaticAsset(
          "STATIC_ASSET_MODE_MISMATCH",
          "静态素材计划与构建上下文模式不一致。",
          {sourcePath: "build-context/static"},
        );
      }
      staticIdentity = captureStaticDirectoryIdentity(verifiedContext);
      assertEmptyStaticDirectory(verifiedContext);
      for (const file of this.#pendingFiles) {
        const target = resolve(verifiedContext.staticDirectory, file.manifest.targetPath);
        const relation = relative(verifiedContext.staticDirectory, target);
        if (
          relation === ""
          || relation === ".."
          || relation.startsWith(`..${sep}`)
          || isAbsolute(relation)
        ) {
          failStaticAsset(
            "STATIC_ASSET_TARGET_ESCAPE",
            "静态白名单目标逃逸临时静态根。",
            {sourcePath: file.manifest.sourcePath},
          );
        }
        materializationStarted = true;
        mkdirSync(dirname(target), {recursive: true, mode: 0o700});
        writeFileSync(target, file.bytes, {flag: "wx", mode: 0o600});
        chmodSync(target, 0o600);
        assertWrittenFile(target, file.bytes.byteLength, file.manifest.sourcePath);
      }
      assertMaterializedTree(verifiedContext, this.#pendingFiles);
      this.#materialized = true;
    } catch (error) {
      operationError = error;
    } finally {
      this.#discardPendingBytes();
    }
    if (operationError !== undefined) {
      if (
        materializationStarted
        && verifiedContext !== undefined
        && staticIdentity !== undefined
      ) cleanupStaticDirectory(verifiedContext, staticIdentity);
      if (operationError instanceof StaticAssetError) throw operationError;
      failStaticAsset(
        "STATIC_ASSET_MATERIALIZE",
        "静态白名单物化失败。",
        {cause: operationError, sourcePath: "build-context/static"},
      );
    }
    return this.manifest;
  }

  assertProductionBuild(buildDirectory: string): void {
    if (this.#disposed) {
      failStaticAsset(
        "STATIC_ASSET_PLAN_CONSUMED",
        "已释放的静态素材计划不能再检查 production 制品。",
        {sourcePath: "build"},
      );
    }
    if (this.#mode !== "production") {
      failStaticAsset(
        "STATIC_ASSET_PRODUCTION_MODE",
        "preview 静态素材计划不能进入 production 制品判定。",
        {sourcePath: "build"},
      );
    }
    if (!this.#materialized) {
      failStaticAsset(
        "STATIC_ASSET_PLAN_NOT_MATERIALIZED",
        "production 制品判定前必须先物化同一静态素材计划。",
        {sourcePath: "build"},
      );
    }
    const pathTokens = uniqueLeakTokens(
      this.#excluded.flatMap((file) => file.pathTokens),
    );
    const contentTokens = uniqueLeakTokens(
      this.#excluded.flatMap((file) => file.contentTokens),
    );
    const ssrProjectFiles = this.#allowed.filter((file) => (
      file.manifest.kind === "project-preview"
    ));
    const ssrPublicUrls = ssrProjectFiles.map((file) => file.manifest.publicUrl);
    const evidence = scanBuildTree(
      buildDirectory,
      pathTokens,
      contentTokens,
      ssrPublicUrls,
    );
    if (evidence.hasLeakedPathToken) {
      failStaticAsset(
        "STATIC_ASSET_UNPUBLISHED_PATH_LEAK",
        "production 制品字节包含未发布素材公开路径。",
        {sourcePath: "build"},
      );
    }
    if (evidence.hasLeakedContentToken) {
      failStaticAsset(
        "STATIC_ASSET_UNPUBLISHED_BYTE_LEAK",
        "production 制品含未发布素材的原始字节或标准 Base64 token。",
        {sourcePath: "build"},
      );
    }
    const byPath = new Map(evidence.files.map((file) => [file.relativePath, file]));
    for (const expected of this.#allowed) {
      const actual = byPath.get(expected.manifest.targetPath);
      if (
        actual === undefined
        || actual.byteLength !== expected.byteLength
        || actual.sha256 !== expected.sha256
      ) {
        failStaticAsset(
          "STATIC_ASSET_BUILD_WHITELIST",
          "production 制品中的白名单文件缺失或字节漂移。",
          {sourcePath: expected.manifest.sourcePath},
        );
      }
    }
    const expectedProjects = new Set(
      this.#allowed
        .filter((file) => file.manifest.kind === "project-preview")
        .map((file) => file.manifest.targetPath),
    );
    const actualProjects = evidence.files
      .filter((file) => file.relativePath.startsWith("assets/projects/"))
      .map((file) => file.relativePath);
    if (
      actualProjects.length !== expectedProjects.size
      || actualProjects.some((path) => !expectedProjects.has(path))
    ) {
      failStaticAsset(
        "STATIC_ASSET_BUILD_PROJECT_SET",
        "production 制品项目素材集合与白名单不一致。",
        {sourcePath: "build/assets/projects"},
      );
    }
    const expectedPublic = new Set(
      this.#allowed
        .filter((file) => file.manifest.kind === "static-public")
        .map((file) => file.manifest.targetPath),
    );
    const actualPublic = evidence.files
      .filter((file) => isManagedStaticPublicBuildPath(file.relativePath))
      .map((file) => file.relativePath);
    if (
      actualPublic.length !== expectedPublic.size
      || actualPublic.some((path) => !expectedPublic.has(path))
    ) {
      failStaticAsset(
        "STATIC_ASSET_BUILD_PUBLIC_SET",
        "production 制品始终公开素材集合与登记不一致。",
        {sourcePath: "build"},
      );
    }
    const excludedHashes = new Set(this.#excluded.map((file) => file.sha256));
    if (evidence.files.some((file) => excludedHashes.has(file.sha256))) {
      failStaticAsset(
        "STATIC_ASSET_UNPUBLISHED_BYTE_LEAK",
        "production 制品含未发布素材的同字节副本。",
        {sourcePath: "build"},
      );
    }
    for (let index = 0; index < ssrPublicUrls.length; index += 1) {
      if (!evidence.ssrImageReferenceIndexes.has(index)) {
        failStaticAsset(
          "STATIC_ASSET_SSR_REFERENCE",
          "公开项目预览未被 SSR HTML 的真实图片属性引用。",
          {sourcePath: ssrProjectFiles[index]?.manifest.sourcePath ?? "site-assets"},
        );
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#consumed = true;
    this.#discardPendingBytes();
    this.#discardExcludedTokens();
  }
}

function getStaticAssetPlanPrivateState(
  plan: StaticAssetPlan,
): StaticAssetPlanPrivateState {
  const state = plan !== null && typeof plan === "object"
    ? staticAssetPlanPrivateStates.get(plan)
    : undefined;
  if (state === undefined) {
    failStaticAsset(
      "STATIC_ASSET_PLAN_PROVENANCE",
      "静态素材输入摘要只接受本次安全准备形成的计划。",
      {sourcePath: "site-assets"},
    );
  }
  return state;
}

export function getStaticAssetPlanInputDigest(plan: StaticAssetPlan): string {
  return getStaticAssetPlanPrivateState(plan).inputDigest;
}

export function assertStaticAssetPlanInputsCurrent(
  plan: StaticAssetPlan,
): void {
  getStaticAssetPlanPrivateState(plan).assertInputsCurrent();
}

function prepareStaticAssetPlanInternal(
  input: PrepareStaticAssetPlanInput,
): StaticAssetPlan {
  if (input === null || typeof input !== "object") {
    failStaticAsset(
      "STATIC_ASSET_INPUT",
      "静态素材计划输入必须是 object。",
      {sourcePath: "site-assets"},
    );
  }
  if (input.mode !== "production" && input.mode !== "preview") {
    failStaticAsset(
      "STATIC_ASSET_MODE",
      "静态素材计划模式必须是 production 或 preview。",
      {sourcePath: "site-assets"},
    );
  }
  assertValidatedCatalog(input.catalog);
  const repositoryRoot = assertCanonicalRepositoryRoot(input.repositoryRoot);
  const registry = decodeStaticPublicRegistry(input.staticPublicRegistry);
  let media: ProjectScanResult | undefined;
  let publicResult: StaticPublicScanResult | undefined;
  let genericUnpublished: readonly GenericUnpublishedSnapshot[] = Object.freeze([]);
  try {
    media = scanProjectMedia(repositoryRoot, input.catalog);
    const mediaResult = validateProjectMedia({
      catalog: input.catalog,
      sources: media.sources,
    });
    if (!mediaResult.ok) {
      const first = mediaResult.issues[0];
      failStaticAsset(
        "STATIC_ASSET_MEDIA_VALIDATION",
        "项目主预览媒体没有通过 I-11 整批门禁。",
        {
          sourcePath: first?.sourcePath ?? "site-assets",
          upstreamCode: first?.code,
        },
      );
    }
    publicResult = scanStaticPublic(repositoryRoot, registry);
    const physicalDigest = staticPhysicalSourceDigest(media, publicResult);
    genericUnpublished = snapshotGenericUnpublished(input.unpublishedAssets);
    assertCombinedSnapshotTotal(
      media.snapshots,
      publicResult.snapshots,
      genericUnpublished,
    );
    const privateFiles = createPrivateFiles(
      input.mode,
      input.catalog,
      mediaResult.value,
      media.snapshots,
      publicResult.snapshots,
      genericUnpublished,
    );
    return new PreparedStaticAssetPlan(
      input.mode,
      privateFiles.allowed,
      privateFiles.excluded,
      createStaticInputsCurrentAssertion({
        repositoryRoot,
        catalog: input.catalog,
        registry,
        expectedPhysicalDigest: physicalDigest,
      }),
    );
  } catch (error) {
    if (media !== undefined) {
      for (const bytes of media.snapshots.values()) bytes.fill(0);
    }
    if (publicResult !== undefined) {
      for (const snapshot of publicResult.snapshots) snapshot.bytes.fill(0);
    }
    for (const snapshot of genericUnpublished) snapshot.bytes.fill(0);
    if (error instanceof StaticAssetError) throw error;
    failStaticAsset(
      "STATIC_ASSET_INTERNAL",
      "静态素材计划准备发生未分类错误。",
      {cause: error, sourcePath: "site-assets"},
    );
  }
}

export function prepareStaticAssetPlan(
  input: PrepareStaticAssetPlanInput,
): StaticAssetPlan {
  try {
    return prepareStaticAssetPlanInternal(snapshotPrepareInput(input));
  } catch (error) {
    if (error instanceof StaticAssetError) throw error;
    failStaticAsset(
      "STATIC_ASSET_INPUT",
      "静态素材计划输入读取发生异常。",
      {cause: error, sourcePath: "site-assets"},
    );
  }
}

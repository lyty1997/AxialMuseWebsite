import type {
  PreviewImage,
  Project,
  ProjectCatalog,
  ProjectMediaSourceInput,
  ProjectMediaValidationInput,
  ProjectPreviewAsset,
  ValidationResult,
} from "./types.js";
import {
  compareCodePoints,
  failure,
  isRecord,
  isSafeDiagnosticPath,
  IssueCollector,
  success,
} from "./validation.js";

const PROJECTS_PATH = "docs/contracts/projects.json";
const ASSET_ROOT = "site-assets";
const PROJECT_ASSET_PATTERN = /^site-assets\/projects\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\.webp$/u;
const MAX_PREVIEW_BYTES = 300_000;
const SOURCE_KEYS = Object.freeze([
  "sourcePath",
  "isSymbolicLink",
  "isRealPathWithinRoot",
  "isRegularFile",
  "bytes",
]);
const SOURCE_REQUIRED_KEYS = Object.freeze([
  "sourcePath",
  "isSymbolicLink",
  "isRealPathWithinRoot",
  "isRegularFile",
]);
const SOURCE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;
const TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)?.get;

interface MediaReference {
  readonly projectId: string;
  readonly preview: PreviewImage;
  readonly repositoryPath: string;
}

interface MediaProbe {
  readonly inputIndex: number;
  readonly sourcePath: string;
  readonly inspection?: WebPInspection;
  readonly usable: boolean;
}

type WebPInspection =
  | Readonly<{kind: "static"; width: number; height: number}>
  | Readonly<{kind: "animated"}>
  | Readonly<{kind: "invalid"}>;

interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

type ByteSnapshot =
  | Readonly<{kind: "invalid"}>
  | Readonly<{kind: "oversized"}>
  | Readonly<{kind: "valid"; bytes: Uint8Array}>;

interface SourceSnapshot {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly isShapeValid: boolean;
}

function hasPreviewShape(value: unknown): value is PreviewImage {
  return isRecord(value)
    && typeof value.sourcePath === "string"
    && value.width === 1600
    && value.height === 1000
    && typeof value.alt === "string";
}

function hasProjectShape(value: unknown): value is Project {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || !["draft", "planned", "published", "archived"].includes(value.publicationStatus as string)
    || (value.previewImage !== undefined && !hasPreviewShape(value.previewImage))
  ) return false;
  return !["published", "archived"].includes(value.publicationStatus as string)
    || value.previewImage !== undefined;
}

function hasCatalogShape(value: unknown): value is ProjectCatalog {
  return isRecord(value)
    && Array.isArray(value.projects)
    && value.projects.every(hasProjectShape)
    && Array.isArray(value.authors)
    && Array.isArray(value.topics)
    && Array.isArray(value.experiences)
    && Array.isArray(value.projectSources);
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    + (bytes[offset + 1] * 0x100)
    + (bytes[offset + 2] * 0x1_0000)
    + (bytes[offset + 3] * 0x100_0000)
  );
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function parseVp8(bytes: Uint8Array, offset: number, size: number): ImageDimensions | undefined {
  if (size <= 10) return undefined;
  const frameTag = readUint24LittleEndian(bytes, offset);
  const isKeyFrame = (frameTag & 0x01) === 0;
  const version = (frameTag >>> 1) & 0x07;
  const isVisible = ((frameTag >>> 4) & 0x01) === 1;
  const firstPartitionSize = frameTag >>> 5;
  if (
    !isKeyFrame
    || version > 3
    || !isVisible
    || firstPartitionSize === 0
    || firstPartitionSize + 10 > size
    || bytes[offset + 3] !== 0x9d
    || bytes[offset + 4] !== 0x01
    || bytes[offset + 5] !== 0x2a
  ) return undefined;
  const width = readUint16LittleEndian(bytes, offset + 6) & 0x3fff;
  const height = readUint16LittleEndian(bytes, offset + 8) & 0x3fff;
  return width > 0 && height > 0 ? {width, height} : undefined;
}

function parseVp8l(bytes: Uint8Array, offset: number, size: number): ImageDimensions | undefined {
  if (size <= 5 || bytes[offset] !== 0x2f) return undefined;
  const dimensions = readUint32LittleEndian(bytes, offset + 1);
  if ((dimensions >>> 29) !== 0) return undefined;
  return {
    width: (dimensions & 0x3fff) + 1,
    height: ((dimensions >>> 14) & 0x3fff) + 1,
  };
}

function parseVp8x(bytes: Uint8Array, offset: number, size: number): (
  ImageDimensions & Readonly<{animated: boolean}>
) | undefined {
  if (
    size !== 10
    || (bytes[offset] & 0xc1) !== 0
    || bytes[offset + 1] !== 0
    || bytes[offset + 2] !== 0
    || bytes[offset + 3] !== 0
  ) return undefined;
  const result = {
    animated: (bytes[offset] & 0x02) !== 0,
    width: readUint24LittleEndian(bytes, offset + 4) + 1,
    height: readUint24LittleEndian(bytes, offset + 7) + 1,
  };
  return result.width * result.height <= 0xffff_ffff ? result : undefined;
}

function inspectWebP(bytes: Uint8Array): WebPInspection {
  if (
    bytes.byteLength < 20
    || ascii(bytes, 0) !== "RIFF"
    || ascii(bytes, 8) !== "WEBP"
    || readUint32LittleEndian(bytes, 4) + 8 !== bytes.byteLength
    || bytes.byteLength % 2 !== 0
  ) return {kind: "invalid"};

  let offset = 12;
  let chunkIndex = 0;
  let animated = false;
  let extended: (ImageDimensions & Readonly<{animated: boolean}>) | undefined;
  const imageDimensions: ImageDimensions[] = [];
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return {kind: "invalid"};
    const tag = ascii(bytes, offset);
    const size = readUint32LittleEndian(bytes, offset + 4);
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + size;
    const paddedEnd = payloadEnd + (size % 2);
    if (payloadEnd < payloadOffset || paddedEnd > bytes.byteLength) return {kind: "invalid"};
    if (size % 2 === 1 && bytes[payloadEnd] !== 0) return {kind: "invalid"};

    if (tag === "VP8X") {
      if (extended !== undefined || chunkIndex !== 0) return {kind: "invalid"};
      extended = parseVp8x(bytes, payloadOffset, size);
      if (extended === undefined) return {kind: "invalid"};
      animated ||= extended.animated;
    } else if (tag === "VP8 ") {
      const dimensions = parseVp8(bytes, payloadOffset, size);
      if (dimensions === undefined) return {kind: "invalid"};
      imageDimensions.push(dimensions);
    } else if (tag === "VP8L") {
      const dimensions = parseVp8l(bytes, payloadOffset, size);
      if (dimensions === undefined) return {kind: "invalid"};
      imageDimensions.push(dimensions);
    } else if (tag === "ANIM" || tag === "ANMF") {
      animated = true;
    }

    offset = paddedEnd;
    chunkIndex += 1;
  }
  if (offset !== bytes.byteLength) return {kind: "invalid"};
  if (animated) return {kind: "animated"};
  if (imageDimensions.length !== 1) return {kind: "invalid"};
  const image = imageDimensions[0];
  if (extended === undefined) {
    return chunkIndex === 1
      ? {kind: "static", width: image.width, height: image.height}
      : {kind: "invalid"};
  }
  return extended.width === image.width && extended.height === image.height
    ? {kind: "static", width: extended.width, height: extended.height}
    : {kind: "invalid"};
}

function snapshotBytes(value: unknown): ByteSnapshot {
  let snapshot: Uint8Array | undefined;
  try {
    if (
      typeof TYPED_ARRAY_BYTE_LENGTH !== "function"
      || typeof TYPED_ARRAY_TAG !== "function"
      || !ArrayBuffer.isView(value)
      || Reflect.apply(TYPED_ARRAY_TAG, value, []) !== "Uint8Array"
    ) return {kind: "invalid"};
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []) as unknown;
    if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) {
      return {kind: "invalid"};
    }
    if ((byteLength as number) > MAX_PREVIEW_BYTES) return {kind: "oversized"};
    snapshot = new Uint8Array(byteLength as number);
    Uint8Array.prototype.set.call(snapshot, value as Uint8Array);
    const result: ByteSnapshot = {kind: "valid", bytes: snapshot};
    snapshot = undefined;
    return result;
  } catch {
    snapshot?.fill(0);
    return {kind: "invalid"};
  }
}

function isProjectAssetPath(value: unknown): value is string {
  return typeof value === "string"
    && isSafeDiagnosticPath(value)
    && PROJECT_ASSET_PATTERN.test(value);
}

function snapshotSource(
  value: unknown,
  inputIndex: number,
  collector: IssueCollector,
): SourceSnapshot | undefined {
  const field = `sources.${inputIndex}`;
  if (!isRecord(value)) {
    collector.add("CONTENT_PROJECT_MEDIA_SOURCE_INVALID", ASSET_ROOT, field, "媒体候选必须是普通 object。");
    return undefined;
  }

  let keys: readonly PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch {
    collector.add("CONTENT_PROJECT_MEDIA_SOURCE_INVALID", ASSET_ROOT, field, "媒体候选字段不可安全读取。");
    return undefined;
  }

  const sourcePathDescriptor = descriptors.sourcePath;
  const sourcePath = sourcePathDescriptor !== undefined
    && Object.hasOwn(sourcePathDescriptor, "value")
    && typeof sourcePathDescriptor.value === "string"
    && isSafeDiagnosticPath(sourcePathDescriptor.value)
    ? sourcePathDescriptor.value
    : ASSET_ROOT;
  const allowed = new Set<string>(SOURCE_KEYS);
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let isShapeValid = true;
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      const diagnosticKey = typeof key === "string" && SOURCE_KEY_PATTERN.test(key)
        ? key
        : "unknownField";
      collector.add(
        "CONTENT_PROJECT_MEDIA_SOURCE_FIELD_UNKNOWN",
        sourcePath,
        `${field}.${diagnosticKey}`,
        "字段不属于当前媒体候选 schema。",
      );
      isShapeValid = false;
      continue;
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, "value")
    ) {
      collector.add(
        "CONTENT_PROJECT_MEDIA_SOURCE_INVALID",
        sourcePath,
        `${field}.${key}`,
        "媒体候选字段必须是可枚举的普通数据属性。",
      );
      isShapeValid = false;
      continue;
    }
    fields[key] = descriptor.value;
  }
  for (const key of SOURCE_REQUIRED_KEYS) {
    if (Object.hasOwn(fields, key)) continue;
    collector.add(
      "CONTENT_PROJECT_MEDIA_SOURCE_FIELD_REQUIRED",
      sourcePath,
      `${field}.${key}`,
      "媒体候选缺少必填字段。",
    );
    isShapeValid = false;
  }
  return {fields, isShapeValid};
}

function validateSource(
  value: unknown,
  inputIndex: number,
  collector: IssueCollector,
): MediaProbe | undefined {
  const field = `sources.${inputIndex}`;
  const snapshot = snapshotSource(value, inputIndex, collector);
  if (snapshot === undefined) return undefined;
  const source = snapshot.fields;
  const sourcePath = typeof source.sourcePath === "string" && isSafeDiagnosticPath(source.sourcePath)
    ? source.sourcePath
    : ASSET_ROOT;
  let usable = snapshot.isShapeValid;
  if (!isProjectAssetPath(source.sourcePath)) {
    collector.add(
      "CONTENT_PROJECT_MEDIA_PATH",
      sourcePath,
      `${field}.sourcePath`,
      "项目媒体路径必须位于 site-assets/projects/<project-id>/ 且使用 lowercase WebP 文件名。",
    );
    usable = false;
  }
  if (typeof source.isSymbolicLink !== "boolean") {
    collector.add("CONTENT_PROJECT_MEDIA_SOURCE_INVALID", sourcePath, `${field}.isSymbolicLink`, "符号链接事实必须是 boolean。");
    usable = false;
  } else if (source.isSymbolicLink) {
    collector.add("CONTENT_PROJECT_MEDIA_SYMBOLIC_LINK", sourcePath, `${field}.isSymbolicLink`, "项目媒体不得是符号链接。");
    usable = false;
  }
  if (typeof source.isRealPathWithinRoot !== "boolean") {
    collector.add("CONTENT_PROJECT_MEDIA_SOURCE_INVALID", sourcePath, `${field}.isRealPathWithinRoot`, "realpath 包含事实必须是 boolean。");
    usable = false;
  } else if (!source.isRealPathWithinRoot) {
    collector.add("CONTENT_PROJECT_MEDIA_REALPATH_ESCAPE", sourcePath, `${field}.isRealPathWithinRoot`, "项目媒体真实路径未被证明位于 site-assets 根内。");
    usable = false;
  }
  if (typeof source.isRegularFile !== "boolean") {
    collector.add("CONTENT_PROJECT_MEDIA_SOURCE_INVALID", sourcePath, `${field}.isRegularFile`, "普通文件事实必须是 boolean。");
    usable = false;
  } else if (!source.isRegularFile) {
    collector.add("CONTENT_PROJECT_MEDIA_FILE_TYPE", sourcePath, `${field}.isRegularFile`, "项目媒体必须是普通文件。");
    usable = false;
  }
  let inspection: WebPInspection | undefined;
  const isSafeRegularFile = source.isSymbolicLink === false
    && source.isRealPathWithinRoot === true
    && source.isRegularFile === true;
  const hasBytes = Object.hasOwn(source, "bytes");
  if (!isSafeRegularFile) {
    if (hasBytes) {
      collector.add(
        "CONTENT_PROJECT_MEDIA_BYTES_UNEXPECTED",
        sourcePath,
        `${field}.bytes`,
        "未证明安全的媒体候选不得携带文件字节。",
      );
    }
    usable = false;
  } else {
    if (!hasBytes) {
      collector.add(
        "CONTENT_PROJECT_MEDIA_SOURCE_FIELD_REQUIRED",
        sourcePath,
        `${field}.bytes`,
        "安全普通文件候选必须携带同次读取的字节快照。",
      );
      usable = false;
    } else {
      const bytes = snapshotBytes(source.bytes);
      if (bytes.kind === "invalid") {
        collector.add("CONTENT_PROJECT_MEDIA_BYTES_INVALID", sourcePath, `${field}.bytes`, "媒体字节必须是真实 Uint8Array。");
        usable = false;
      } else if (bytes.kind === "oversized") {
        collector.add("CONTENT_PROJECT_MEDIA_SIZE", sourcePath, `${field}.bytes`, "项目主预览不得超过 300,000 bytes。");
        usable = false;
      } else {
        try {
          inspection = inspectWebP(bytes.bytes);
          if (inspection.kind === "invalid") {
            collector.add("CONTENT_PROJECT_MEDIA_SIGNATURE", sourcePath, `${field}.bytes`, "媒体不是结构完整且可读取尺寸的静态 WebP。");
            usable = false;
          } else if (inspection.kind === "animated") {
            collector.add("CONTENT_PROJECT_MEDIA_ANIMATED", sourcePath, `${field}.bytes`, "项目主预览不得是动画 WebP。");
            usable = false;
          }
        } finally {
          bytes.bytes.fill(0);
        }
      }
    }
  }
  return typeof source.sourcePath === "string" && isProjectAssetPath(source.sourcePath)
    ? {inputIndex, sourcePath: source.sourcePath, inspection, usable}
    : undefined;
}

function createReferences(catalog: ProjectCatalog): readonly MediaReference[] {
  return catalog.projects.flatMap((project) => (
    project.previewImage === undefined
      ? []
      : [{
          projectId: project.id,
          preview: project.previewImage,
          repositoryPath: `${ASSET_ROOT}/${project.previewImage.sourcePath}`,
        }]
  ));
}

function addDuplicateReferenceIssues(
  references: readonly MediaReference[],
  collector: IssueCollector,
): Set<string> {
  const groups = new Map<string, MediaReference[]>();
  for (const reference of references) {
    const group = groups.get(reference.repositoryPath) ?? [];
    group.push(reference);
    groups.set(reference.repositoryPath, group);
  }
  const duplicates = new Set<string>();
  for (const [path, group] of groups) {
    if (group.length < 2) continue;
    duplicates.add(path);
    for (const reference of group) {
      collector.add(
        "CONTENT_PROJECT_MEDIA_REFERENCE_DUPLICATE",
        PROJECTS_PATH,
        `projectsById.${reference.projectId}.previewImage.sourcePath`,
        "多个项目登记了同一主预览文件。",
      );
    }
  }
  return duplicates;
}

export function validateProjectMedia(
  input: ProjectMediaValidationInput,
): ValidationResult<readonly ProjectPreviewAsset[]> {
  const collector = new IssueCollector();
  if (!isRecord(input) || !hasCatalogShape(input.catalog)) {
    collector.add("CONTENT_PROJECT_MEDIA_CATALOG_INVALID", PROJECTS_PATH, undefined, "媒体校验需要完整且已验证的项目目录。");
    return failure(collector);
  }
  if (!Array.isArray(input.sources)) {
    collector.add("CONTENT_PROJECT_MEDIA_SOURCE_INVALID", ASSET_ROOT, "sources", "媒体候选必须是数组。");
    return failure(collector);
  }

  const references = createReferences(input.catalog);
  const duplicateReferences = addDuplicateReferenceIssues(references, collector);
  const probes = input.sources.flatMap((source, index) => {
    const probe = validateSource(source, index, collector);
    return probe === undefined ? [] : [probe];
  });
  const probesByPath = new Map<string, MediaProbe[]>();
  for (const probe of probes) {
    const group = probesByPath.get(probe.sourcePath) ?? [];
    group.push(probe);
    probesByPath.set(probe.sourcePath, group);
  }
  for (const group of probesByPath.values()) {
    if (group.length < 2) continue;
    for (const probe of group) {
      collector.add(
        "CONTENT_PROJECT_MEDIA_SOURCE_DUPLICATE",
        probe.sourcePath,
        `sources.${probe.inputIndex}.sourcePath`,
        "完整媒体清单中出现重复路径。",
      );
    }
  }

  const referencedPaths = new Set(references.map((reference) => reference.repositoryPath));
  for (const probe of probes) {
    if (!referencedPaths.has(probe.sourcePath)) {
      collector.add("CONTENT_PROJECT_MEDIA_ORPHAN", probe.sourcePath, undefined, "项目媒体没有唯一注册表引用。");
    }
  }

  const previews: ProjectPreviewAsset[] = [];
  for (const reference of references) {
    const group = probesByPath.get(reference.repositoryPath) ?? [];
    if (group.length === 0) {
      collector.add(
        "CONTENT_PROJECT_MEDIA_MISSING",
        PROJECTS_PATH,
        `projectsById.${reference.projectId}.previewImage.sourcePath`,
        "登记的项目主预览文件不存在。",
      );
      continue;
    }
    if (group.length !== 1 || duplicateReferences.has(reference.repositoryPath)) continue;
    const probe = group[0];
    if (probe.inspection?.kind !== "static" || !probe.usable) continue;
    if (
      probe.inspection.width !== reference.preview.width
      || probe.inspection.height !== reference.preview.height
    ) {
      collector.add(
        "CONTENT_PROJECT_MEDIA_DIMENSIONS",
        probe.sourcePath,
        `sources.${probe.inputIndex}.bytes`,
        "WebP 实际尺寸与登记的 1600 x 1000 不一致。",
      );
      continue;
    }
    previews.push({
      projectId: reference.projectId,
      sourcePath: reference.preview.sourcePath,
      publicUrl: `/assets/${reference.preview.sourcePath}`,
      width: reference.preview.width,
      height: reference.preview.height,
      alt: reference.preview.alt,
    });
  }
  if (collector.hasIssues()) return failure(collector);
  previews.sort((left, right) => (
    compareCodePoints(left.projectId, right.projectId)
    || compareCodePoints(left.sourcePath, right.sourcePath)
  ));
  return success(previews);
}

import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import test from "node:test";
import {runInNewContext} from "node:vm";
import {gunzipSync} from "node:zlib";
import {
  validateProjectCatalog,
  validateProjectMedia,
} from "../../src/domain/content/index.js";
import type {
  ContentIssue,
  Project,
  ProjectCatalog,
  ProjectCatalogInput,
  ProjectMediaSourceInput,
  ProjectPreviewAsset,
  ValidationResult,
} from "../../src/domain/content/index.js";

const LIFECYCLE_STATUSES = ["active", "paused", "completed", "archived"];
const PUBLICATION_STATUSES = ["draft", "planned", "published", "archived"];
const SHOWCASE_MODES = ["repository", "repository-and-video"];
const EXPERIENCE_STATUSES = ["planned", "provisioning", "live", "paused", "retired"];
const RESERVED_SUBDOMAINS = [
  "www",
  "api",
  "admin",
  "auth",
  "account",
  "assets",
  "cdn",
  "dev",
  "docs",
  "mail",
  "preview",
  "staging",
  "static",
  "status",
  "support",
];
const REAL_STATIC_VP8L_BASE64 = "UklGRmYAAABXRUJQVlA4TFkAAAAvP8b5AAdQkEIUpv8BAEX6/58i+p/63//+97///e9///vf//73v//973//+9///ve///3vf//73//+97///e9///vf//73v//973//+9///ve///3vf/+7BQA=";
const REAL_STATIC_VP8_GZIP_BASE64 = "H4sIAAAAAAAC/wvydHMr4WZgCHd1CggLsFDIALIDwhjnMmo5sL1gtss1m+W5RGnRQgUOhgbezsy8h+WJ0g7c3ilPbL+dPFH9dvKE77fVFd9v83O+nzOnfd9NS/7aTUVyv0elR6VHpUelR6VHpUelR6VHpUel6SG9h4Hh3//7ZfVXl1zSt/8y3bvbgWEwAwA+IAssfAsAAA==";
const MEDIA_IDENTITIES = [
  ["beta-draft", "draft-review.webp"],
  ["gamma-published", "published-dashboard.webp"],
  ["omega-archived", "archived-release.webp"],
] as const;

function realStaticVp8l(): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(REAL_STATIC_VP8L_BASE64, "base64"));
  assert.equal(bytes.byteLength, 110);
  return bytes;
}

function realStaticVp8(): Uint8Array {
  const bytes = new Uint8Array(gunzipSync(Buffer.from(REAL_STATIC_VP8_GZIP_BASE64, "base64")));
  assert.equal(bytes.byteLength, 2940);
  return bytes;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function writeUint24LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

function writeUint32LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    + (bytes[offset + 1] * 0x100)
    + (bytes[offset + 2] * 0x1_0000)
    + (bytes[offset + 3] * 0x100_0000)
  );
}

function fourCc(value: string): Uint8Array {
  assert.equal(value.length, 4);
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function createChunk(tag: string, payload: Uint8Array): Uint8Array {
  const padding = payload.byteLength % 2;
  const result = new Uint8Array(8 + payload.byteLength + padding);
  result.set(fourCc(tag), 0);
  writeUint32LittleEndian(result, 4, payload.byteLength);
  result.set(payload, 8);
  return result;
}

function createRiff(chunks: readonly Uint8Array[]): Uint8Array {
  const body = concatBytes(...chunks);
  const result = new Uint8Array(12 + body.byteLength);
  result.set(fourCc("RIFF"), 0);
  writeUint32LittleEndian(result, 4, result.byteLength - 8);
  result.set(fourCc("WEBP"), 8);
  result.set(body, 12);
  return result;
}

function createVp8xChunk(): Uint8Array {
  const extendedHeader = new Uint8Array(10);
  writeUint24LittleEndian(extendedHeader, 4, 1599);
  writeUint24LittleEndian(extendedHeader, 7, 999);
  return createChunk("VP8X", extendedHeader);
}

function createExtendedVp8l(additionalChunks: readonly Uint8Array[] = []): Uint8Array {
  return createRiff([
    createVp8xChunk(),
    realStaticVp8l().slice(12),
    ...additionalChunks,
  ]);
}

function createSizedExtendedWebP(byteLength: number): Uint8Array {
  const base = createExtendedVp8l();
  const fillerLength = byteLength - base.byteLength - 8;
  assert.ok(fillerLength > 0 && fillerLength % 2 === 0);
  const result = createExtendedVp8l([createChunk("JUNK", new Uint8Array(fillerLength))]);
  assert.equal(result.byteLength, byteLength);
  return result;
}

function createAnimatedFlagWebP(): Uint8Array {
  const bytes = createExtendedVp8l();
  bytes[20] |= 0x02;
  return bytes;
}

function createWrongWidthWebP(): Uint8Array {
  const bytes = realStaticVp8l();
  const encoded = readUint32LittleEndian(bytes, 21);
  writeUint32LittleEndian(bytes, 21, (encoded & ~0x3fff) | (1599 - 1));
  return bytes;
}

function projectRecord(
  id: string,
  navigationOrder: number,
  publicationStatus: "draft" | "planned" | "published" | "archived",
  previewName?: string,
): Record<string, unknown> {
  return {
    id,
    title: id.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "),
    slug: id,
    navigationOrder,
    summary: `Traceable implementation summary for ${id} with enough factual detail.`,
    status: publicationStatus === "archived" ? "archived" : "active",
    publicationStatus,
    startedAt: "2026-01",
    updatedAt: "2026-07-01",
    repositoryUrl: `https://example.com/${id}`,
    productionBranch: "main",
    showcaseMode: "repository",
    ...(previewName === undefined
      ? {}
      : {
          previewImage: {
            sourcePath: `projects/${id}/${previewName}`,
            width: 1600,
            height: 1000,
            alt: `${id} interface showing a verified project state`,
          },
        }),
    source: [`docs/projects/${id}.md`],
  };
}

function createCatalogInput(): ProjectCatalogInput {
  return {
    projects: {
      sourcePath: "docs/contracts/projects.json",
      value: {
        version: "0.3.0",
        kind: "axial_muse_projects",
        status: "active",
        owner: "AxialMuseWebsite",
        lifecycleStatusValues: [...LIFECYCLE_STATUSES],
        publicationStatusValues: [...PUBLICATION_STATUSES],
        showcaseModes: [...SHOWCASE_MODES],
        projects: [
          projectRecord("alpha-plan", 1, "planned"),
          projectRecord("beta-draft", 2, "draft", "draft-review.webp"),
          projectRecord("gamma-published", 3, "published", "published-dashboard.webp"),
          projectRecord("omega-archived", 4, "archived", "archived-release.webp"),
        ],
      },
    },
    authors: {
      sourcePath: "docs/contracts/authors.json",
      value: {
        version: "0.1.0",
        kind: "axial_muse_authors",
        status: "active",
        owner: "AxialMuseWebsite",
        authors: {},
      },
    },
    topics: {
      sourcePath: "docs/contracts/topics.json",
      value: {
        version: "0.1.0",
        kind: "axial_muse_topics",
        status: "active",
        owner: "AxialMuseWebsite",
        topics: {},
      },
    },
    experiences: {
      sourcePath: "docs/contracts/project-experiences.json",
      value: {
        version: "0.1.0",
        kind: "axial_muse_project_experiences",
        status: "active",
        owner: "AxialMuseWebsite",
        canonicalDomain: "axialmuse.com",
        defaultDeliveryMode: "static",
        defaultIndexing: "noindex",
        statusValues: [...EXPERIENCE_STATUSES],
        deliveryModes: ["static"],
        reservedSubdomains: [...RESERVED_SUBDOMAINS],
        experiences: [],
      },
    },
    projectSources: [
      {
        sourcePath: "site-content/projects/gamma-published/index.md",
        isSymbolicLink: false,
        isRealPathWithinRoot: true,
        frontMatter: {},
        content: "## Published evidence\n\nVerified project evidence.\n",
      },
      {
        sourcePath: "site-content/projects/omega-archived/index.md",
        isSymbolicLink: false,
        isRealPathWithinRoot: true,
        frontMatter: {},
        content: "## Archived evidence\n\nVerified archived evidence.\n",
      },
    ],
  };
}

function rawProjects(input: ProjectCatalogInput): Array<Record<string, unknown>> {
  return (input.projects.value as Record<string, unknown>).projects as Array<Record<string, unknown>>;
}

function rawProject(input: ProjectCatalogInput, id: string): Record<string, unknown> {
  const project = rawProjects(input).find((entry) => entry.id === id);
  assert.ok(project, `测试 catalog 缺少项目 ${id}`);
  return project;
}

function rawPreview(input: ProjectCatalogInput, id: string): Record<string, unknown> {
  const preview = rawProject(input, id).previewImage;
  assert.ok(preview !== null && typeof preview === "object" && !Array.isArray(preview));
  return preview as Record<string, unknown>;
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value as Record<string, unknown>)) {
    assertDeepFrozen(child, seen);
  }
}

function expectCatalogSuccess(result: ValidationResult<ProjectCatalog>): ProjectCatalog {
  if (!result.ok) {
    assert.fail(`预期 catalog 成功，实际为 ${result.issues.map((issue) => issue.code).join(", ")}`);
  }
  return result.value;
}

function expectCatalogFailure(
  result: ValidationResult<ProjectCatalog>,
  requiredCodes: readonly string[],
): readonly ContentIssue[] {
  if (result.ok) assert.fail("预期 catalog 失败，实际返回了 value。");
  assert.equal(Object.hasOwn(result, "value"), false);
  for (const code of requiredCodes) {
    assert.ok(result.issues.some((issue) => issue.code === code), `缺少问题码 ${code}`);
  }
  return result.issues;
}

function expectMediaSuccess(
  result: ValidationResult<readonly ProjectPreviewAsset[]>,
): readonly ProjectPreviewAsset[] {
  if (!result.ok) {
    assert.fail(`预期媒体成功，实际为 ${result.issues.map((issue) => issue.code).join(", ")}`);
  }
  assertDeepFrozen(result);
  return result.value;
}

function expectMediaFailure(
  result: ValidationResult<readonly ProjectPreviewAsset[]>,
  requiredCodes: readonly string[],
): readonly ContentIssue[] {
  if (result.ok) assert.fail("预期媒体失败，实际返回了 value。");
  assert.equal(Object.hasOwn(result, "value"), false);
  assertDeepFrozen(result);
  for (const code of requiredCodes) {
    assert.ok(
      result.issues.some((issue) => issue.code === code),
      `缺少问题码 ${code}；实际为 ${result.issues.map((issue) => issue.code).join(", ")}`,
    );
  }
  return result.issues;
}

function mediaSource(
  projectId: string,
  fileName: string,
  bytes = realStaticVp8l(),
): ProjectMediaSourceInput {
  return {
    sourcePath: `site-assets/projects/${projectId}/${fileName}`,
    isSymbolicLink: false,
    isRealPathWithinRoot: true,
    isRegularFile: true,
    bytes,
  };
}

function validMediaSources(): ProjectMediaSourceInput[] {
  return MEDIA_IDENTITIES.map(([projectId, fileName]) => mediaSource(projectId, fileName));
}

function sourcesWithGammaBytes(bytes: Uint8Array): ProjectMediaSourceInput[] {
  return validMediaSources().map((source) => (
    source.sourcePath.includes("/gamma-published/") ? {...source, bytes} : source
  ));
}

function withoutBytes(source: ProjectMediaSourceInput): ProjectMediaSourceInput {
  return {
    sourcePath: source.sourcePath,
    isSymbolicLink: source.isSymbolicLink,
    isRealPathWithinRoot: source.isRealPathWithinRoot,
    isRegularFile: source.isRegularFile,
  };
}

function repositoryCatalogInput(): ProjectCatalogInput {
  const root = process.cwd();
  const registry = (sourcePath: string) => ({
    sourcePath,
    value: JSON.parse(readFileSync(resolve(root, sourcePath), "utf8")) as unknown,
  });
  return {
    projects: registry("docs/contracts/projects.json"),
    authors: registry("docs/contracts/authors.json"),
    topics: registry("docs/contracts/topics.json"),
    experiences: registry("docs/contracts/project-experiences.json"),
    projectSources: [
      "site-content/projects/docrestore/index.md",
      "site-content/projects/vibecoding-project-scaffold/index.md",
    ].map((sourcePath) => ({
      sourcePath,
      isSymbolicLink: lstatSync(resolve(root, sourcePath)).isSymbolicLink(),
      isRealPathWithinRoot: true,
      frontMatter: {},
      content: readFileSync(resolve(root, sourcePath), "utf8"),
    })),
  };
}

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

function scanFixtureAsset(assetRoot: string, relativePath: string): ProjectMediaSourceInput {
  const realRoot = realpathSync(assetRoot);
  const lexicalPath = resolve(assetRoot, relativePath);
  const metadata = lstatSync(lexicalPath);
  const realPath = realpathSync(lexicalPath);
  const relation = relative(realRoot, realPath);
  const isSymbolicLink = metadata.isSymbolicLink();
  const isRealPathWithinRoot = relation === ""
    || (!relation.startsWith("..") && !isAbsolute(relation));
  const isRegularFile = metadata.isFile();
  return {
    sourcePath: `site-assets/${toPosix(relativePath)}`,
    isSymbolicLink,
    isRealPathWithinRoot,
    isRegularFile,
    ...(!isSymbolicLink && isRealPathWithinRoot && isRegularFile
      ? {bytes: new Uint8Array(readFileSync(lexicalPath))}
      : {}),
  };
}

test("I-11 真实 VP8L 正常路径覆盖公开、归档、草稿与 planned 省略并稳定投影 URL", () => {
  const catalog = expectCatalogSuccess(validateProjectCatalog(createCatalogInput()));
  const expected = expectMediaSuccess(validateProjectMedia({
    catalog,
    sources: validMediaSources(),
  }));
  assert.deepEqual(expected, [
    {
      projectId: "beta-draft",
      sourcePath: "projects/beta-draft/draft-review.webp",
      publicUrl: "/assets/projects/beta-draft/draft-review.webp",
      width: 1600,
      height: 1000,
      alt: "beta-draft interface showing a verified project state",
    },
    {
      projectId: "gamma-published",
      sourcePath: "projects/gamma-published/published-dashboard.webp",
      publicUrl: "/assets/projects/gamma-published/published-dashboard.webp",
      width: 1600,
      height: 1000,
      alt: "gamma-published interface showing a verified project state",
    },
    {
      projectId: "omega-archived",
      sourcePath: "projects/omega-archived/archived-release.webp",
      publicUrl: "/assets/projects/omega-archived/archived-release.webp",
      width: 1600,
      height: 1000,
      alt: "omega-archived interface showing a verified project state",
    },
  ]);
  assert.equal(expected.some((preview) => preview.projectId === "alpha-plan"), false);

  const shuffledCatalog = structuredClone(catalog);
  (shuffledCatalog.projects as unknown as Project[]).reverse();
  const shuffled = expectMediaSuccess(validateProjectMedia({
    catalog: shuffledCatalog,
    sources: validMediaSources().reverse(),
  }));
  assert.deepEqual(shuffled, expected);
});

test("I-11 当前真实两个 planned 项目无预览和无媒体候选通过", () => {
  const catalog = expectCatalogSuccess(validateProjectCatalog(repositoryCatalogInput()));
  assert.deepEqual(catalog.projects.map((project) => project.publicationStatus), ["planned", "planned"]);
  assert.ok(catalog.projects.every((project) => project.previewImage === undefined));
  assert.deepEqual(expectMediaSuccess(validateProjectMedia({catalog, sources: []})), []);
});

test("I-11 preview schema、公开基数、登记尺寸与 alt 反例由 catalog 先失败关闭", () => {
  const unknownField = createCatalogInput();
  rawPreview(unknownField, "gamma-published").unexpected = true;
  expectCatalogFailure(validateProjectCatalog(unknownField), ["CONTENT_PROJECT_FIELD_UNKNOWN"]);

  const missing = createCatalogInput();
  delete rawProject(missing, "gamma-published").previewImage;
  expectCatalogFailure(validateProjectCatalog(missing), ["CONTENT_PROJECT_PREVIEW_REQUIRED"]);

  const dimensions = createCatalogInput();
  rawPreview(dimensions, "gamma-published").width = 1599;
  expectCatalogFailure(validateProjectCatalog(dimensions), ["CONTENT_PROJECT_PREVIEW_DIMENSIONS"]);

  const baseline = createCatalogInput();
  const title = rawProject(baseline, "gamma-published").title;
  const summary = rawProject(baseline, "gamma-published").summary;
  for (const alt of ["", " padded ", "line\nbreak", "a".repeat(161), title, summary]) {
    const input = createCatalogInput();
    rawPreview(input, "gamma-published").alt = alt;
    expectCatalogFailure(validateProjectCatalog(input), ["CONTENT_PROJECT_PREVIEW_ALT"]);
  }
});

test("I-11 缺失、孤儿、重复候选、重复登记和跨项目路径均无部分结果", () => {
  const catalog = expectCatalogSuccess(validateProjectCatalog(createCatalogInput()));
  const validSources = validMediaSources();

  expectMediaFailure(validateProjectMedia({
    catalog,
    sources: validSources.filter((source) => !source.sourcePath.includes("/gamma-published/")),
  }), ["CONTENT_PROJECT_MEDIA_MISSING"]);

  expectMediaFailure(validateProjectMedia({
    catalog,
    sources: [...validSources, mediaSource("alpha-plan", "unused.webp")],
  }), ["CONTENT_PROJECT_MEDIA_ORPHAN"]);

  const gamma = validSources.find((source) => source.sourcePath.includes("/gamma-published/"));
  assert.ok(gamma?.bytes);
  expectMediaFailure(validateProjectMedia({
    catalog,
    sources: [...validSources, {...gamma, bytes: new Uint8Array(gamma.bytes)}],
  }), ["CONTENT_PROJECT_MEDIA_SOURCE_DUPLICATE"]);

  expectMediaFailure(validateProjectMedia({
    catalog,
    sources: validSources.map((source) => (
      source === gamma
        ? {...source, sourcePath: "site-assets/projects/alpha-plan/cross-project.webp"}
        : source
    )),
  }), ["CONTENT_PROJECT_MEDIA_MISSING", "CONTENT_PROJECT_MEDIA_ORPHAN"]);

  const duplicateCatalog = structuredClone(catalog);
  const duplicateProjects = duplicateCatalog.projects as unknown as Array<Record<string, unknown>>;
  const gammaProject = duplicateProjects.find((project) => project.id === "gamma-published");
  const omegaProject = duplicateProjects.find((project) => project.id === "omega-archived");
  assert.ok(gammaProject && omegaProject);
  (omegaProject.previewImage as Record<string, unknown>).sourcePath = (
    gammaProject.previewImage as Record<string, unknown>
  ).sourcePath;
  expectMediaFailure(validateProjectMedia({catalog: duplicateCatalog, sources: validSources}), [
    "CONTENT_PROJECT_MEDIA_REFERENCE_DUPLICATE",
  ]);

  const crossRegistration = createCatalogInput();
  rawPreview(crossRegistration, "gamma-published").sourcePath = "projects/alpha-plan/cross.webp";
  expectCatalogFailure(validateProjectCatalog(crossRegistration), ["CONTENT_PROJECT_PREVIEW_PATH"]);
});

test("I-11 逃逸、绝对、反斜杠与大小写路径稳定失败且诊断不回显临时路径", () => {
  const catalog = expectCatalogSuccess(validateProjectCatalog(createCatalogInput()));
  const invalidPaths = [
    "site-assets/projects/gamma-published/../escape.webp",
    "/tmp/private-preview.webp",
    "site-assets\\projects\\gamma-published\\preview.webp",
    "site-assets/projects/Gamma-Published/Preview.webp",
  ];
  for (const sourcePath of invalidPaths) {
    const sources = validMediaSources().map((source) => (
      source.sourcePath.includes("/gamma-published/") ? {...source, sourcePath} : source
    ));
    const issues = expectMediaFailure(validateProjectMedia({catalog, sources}), [
      "CONTENT_PROJECT_MEDIA_PATH",
    ]);
    assert.ok(issues.every((issue) => !issue.sourcePath.startsWith("/")));
    assert.equal(JSON.stringify(issues).includes("/tmp/private-preview.webp"), false);
  }
});

test("I-11 候选字段、文件事实与真实 symlink/realpath 逃逸均失败关闭", () => {
  const catalog = expectCatalogSuccess(validateProjectCatalog(createCatalogInput()));
  const baseline = validMediaSources();
  const baselineGamma = baseline.find((source) => source.sourcePath.includes("/gamma-published/"));
  assert.ok(baselineGamma?.bytes);
  const mutateGamma = (changes: Record<string, unknown>): ProjectMediaSourceInput[] => baseline.map((source) => (
    source.sourcePath.includes("/gamma-published/")
      ? {...source, ...changes} as unknown as ProjectMediaSourceInput
      : source
  ));
  const unsafeGamma = (changes: Record<string, unknown>): ProjectMediaSourceInput[] => baseline.map((source) => (
    source.sourcePath.includes("/gamma-published/")
      ? {...withoutBytes(source), ...changes} as ProjectMediaSourceInput
      : source
  ));

  const unknown = mutateGamma({unexpected: true});
  expectMediaFailure(validateProjectMedia({catalog, sources: unknown}), [
    "CONTENT_PROJECT_MEDIA_SOURCE_FIELD_UNKNOWN",
  ]);
  expectMediaFailure(validateProjectMedia({catalog, sources: unsafeGamma({isSymbolicLink: true})}), [
    "CONTENT_PROJECT_MEDIA_SYMBOLIC_LINK",
  ]);
  expectMediaFailure(validateProjectMedia({catalog, sources: unsafeGamma({isRealPathWithinRoot: false})}), [
    "CONTENT_PROJECT_MEDIA_REALPATH_ESCAPE",
  ]);
  expectMediaFailure(validateProjectMedia({catalog, sources: unsafeGamma({isRegularFile: false})}), [
    "CONTENT_PROJECT_MEDIA_FILE_TYPE",
  ]);
  expectMediaFailure(validateProjectMedia({catalog, sources: mutateGamma({isSymbolicLink: true})}), [
    "CONTENT_PROJECT_MEDIA_BYTES_UNEXPECTED",
    "CONTENT_PROJECT_MEDIA_SYMBOLIC_LINK",
  ]);

  const missingBytes = baseline.map((source) => (
    source.sourcePath.includes("/gamma-published/") ? withoutBytes(source) : source
  ));
  expectMediaFailure(validateProjectMedia({catalog, sources: missingBytes}), [
    "CONTENT_PROJECT_MEDIA_SOURCE_FIELD_REQUIRED",
  ]);

  const nonEnumerableBytes = baseline.map((source) => {
    if (!source.sourcePath.includes("/gamma-published/")) return source;
    const candidate = {...source};
    Object.defineProperty(candidate, "bytes", {
      configurable: true,
      enumerable: false,
      value: source.bytes,
      writable: true,
    });
    return candidate;
  });
  expectMediaFailure(validateProjectMedia({catalog, sources: nonEnumerableBytes}), [
    "CONTENT_PROJECT_MEDIA_SOURCE_INVALID",
  ]);

  let getterCalls = 0;
  const accessorSource = {...baselineGamma};
  Object.defineProperty(accessorSource, "sourcePath", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("must not escape validator");
    },
  });
  expectMediaFailure(validateProjectMedia({
    catalog,
    sources: baseline.map((source) => (
      source.sourcePath.includes("/gamma-published/")
        ? accessorSource as ProjectMediaSourceInput
        : source
    )),
  }), ["CONTENT_PROJECT_MEDIA_SOURCE_INVALID"]);
  assert.equal(getterCalls, 0);

  const trappedSource = new Proxy(
    {...baselineGamma},
    {ownKeys: () => { throw new Error("must not escape validator"); }},
  );
  expectMediaFailure(validateProjectMedia({
    catalog,
    sources: baseline.map((source) => (
      source.sourcePath.includes("/gamma-published/")
        ? trappedSource as ProjectMediaSourceInput
        : source
    )),
  }), ["CONTENT_PROJECT_MEDIA_SOURCE_INVALID"]);

  const spoofed = new DataView(new ArrayBuffer(16));
  Object.defineProperty(spoofed, Symbol.toStringTag, {value: "Uint8Array"});
  expectMediaFailure(validateProjectMedia({
    catalog,
    sources: mutateGamma({bytes: spoofed}),
  }), ["CONTENT_PROJECT_MEDIA_BYTES_INVALID"]);
  const revokedBytes = Proxy.revocable(realStaticVp8l(), {});
  revokedBytes.revoke();
  expectMediaFailure(validateProjectMedia({
    catalog,
    sources: mutateGamma({bytes: revokedBytes.proxy}),
  }), ["CONTENT_PROJECT_MEDIA_BYTES_INVALID"]);

  const root = mkdtempSync(join(tmpdir(), "axial-muse-i11-media-"));
  try {
    const assetRoot = resolve(root, "site-assets");
    const relativePath = "projects/gamma-published/published-dashboard.webp";
    const previewPath = resolve(assetRoot, relativePath);
    mkdirSync(dirname(previewPath), {recursive: true});
    writeFileSync(previewPath, realStaticVp8l());
    const scanned = scanFixtureAsset(assetRoot, relativePath);
    expectMediaSuccess(validateProjectMedia({
      catalog,
      sources: baseline.map((source) => (
        source.sourcePath.includes("/gamma-published/") ? scanned : source
      )),
    }));

    const outsidePath = resolve(root, "outside.webp");
    writeFileSync(outsidePath, realStaticVp8l());
    unlinkSync(previewPath);
    symlinkSync(outsidePath, previewPath);
    const escaped = scanFixtureAsset(assetRoot, relativePath);
    assert.equal(Object.hasOwn(escaped, "bytes"), false);
    const issues = expectMediaFailure(validateProjectMedia({
      catalog,
      sources: baseline.map((source) => (
        source.sourcePath.includes("/gamma-published/") ? escaped : source
      )),
    }), [
      "CONTENT_PROJECT_MEDIA_SYMBOLIC_LINK",
      "CONTENT_PROJECT_MEDIA_REALPATH_ESCAPE",
      "CONTENT_PROJECT_MEDIA_FILE_TYPE",
    ]);
    assert.equal(JSON.stringify(issues).includes(root), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("I-11 静态 VP8、VP8L 与 VP8X 尺寸头均受同一公开投影契约支持", () => {
  const catalog = expectCatalogSuccess(validateProjectCatalog(createCatalogInput()));
  const crossRealmVp8l = runInNewContext(
    "Uint8Array.from(bytes)",
    {bytes: [...realStaticVp8l()]},
  ) as Uint8Array;
  assert.equal(crossRealmVp8l instanceof Uint8Array, false);
  for (const bytes of [realStaticVp8(), realStaticVp8l(), createExtendedVp8l(), crossRealmVp8l]) {
    const previews = expectMediaSuccess(validateProjectMedia({
      catalog,
      sources: sourcesWithGammaBytes(bytes),
    }));
    assert.equal(
      previews.find((preview) => preview.projectId === "gamma-published")?.publicUrl,
      "/assets/projects/gamma-published/published-dashboard.webp",
    );
  }
});

test("I-11 VP8/VP8L 最小规范头、唯一 bitstream 与完整 chunk 扫描拒绝伪造", () => {
  const catalog = expectCatalogSuccess(validateProjectCatalog(createCatalogInput()));
  const invalidVp8: Uint8Array[] = [];
  const interframe = realStaticVp8();
  interframe[20] |= 0x01;
  invalidVp8.push(interframe);
  const unsupportedProfile = realStaticVp8();
  unsupportedProfile[20] = (unsupportedProfile[20] & ~0x0e) | (4 << 1);
  invalidVp8.push(unsupportedProfile);
  const hiddenFrame = realStaticVp8();
  hiddenFrame[20] &= ~0x10;
  invalidVp8.push(hiddenFrame);
  const wrongStartCode = realStaticVp8();
  wrongStartCode[23] = 0;
  invalidVp8.push(wrongStartCode);
  const partitionEscape = realStaticVp8();
  writeUint24LittleEndian(partitionEscape, 20, (0x7ffff << 5) | 0x10);
  invalidVp8.push(partitionEscape);
  for (const bytes of invalidVp8) {
    expectMediaFailure(validateProjectMedia({
      catalog,
      sources: sourcesWithGammaBytes(bytes),
    }), ["CONTENT_PROJECT_MEDIA_SIGNATURE"]);
  }

  const scaledVp8 = realStaticVp8();
  scaledVp8[27] |= 0xc0;
  scaledVp8[29] |= 0xc0;
  expectMediaSuccess(validateProjectMedia({
    catalog,
    sources: sourcesWithGammaBytes(scaledVp8),
  }));

  const wrongLosslessSignature = realStaticVp8l();
  wrongLosslessSignature[20] = 0;
  const wrongLosslessVersion = realStaticVp8l();
  wrongLosslessVersion[24] |= 0x20;
  for (const bytes of [wrongLosslessSignature, wrongLosslessVersion]) {
    expectMediaFailure(validateProjectMedia({
      catalog,
      sources: sourcesWithGammaBytes(bytes),
    }), ["CONTENT_PROJECT_MEDIA_SIGNATURE"]);
  }

  for (const bytes of [
    createRiff([createVp8xChunk()]),
    createExtendedVp8l([realStaticVp8().slice(12)]),
    createExtendedVp8l([createVp8xChunk()]),
  ]) {
    expectMediaFailure(validateProjectMedia({
      catalog,
      sources: sourcesWithGammaBytes(bytes),
    }), ["CONTENT_PROJECT_MEDIA_SIGNATURE"]);
  }

  const animationTextOnly = createExtendedVp8l([
    createChunk("JUNK", fourCc("ANIM")),
  ]);
  expectMediaSuccess(validateProjectMedia({
    catalog,
    sources: sourcesWithGammaBytes(animationTextOnly),
  }));

  const vp8HeaderOnly = realStaticVp8().slice(20, 30);
  vp8HeaderOnly[0] &= 0x1f;
  vp8HeaderOnly[1] = 0;
  vp8HeaderOnly[2] = 0;
  const vp8xCanvasMismatch = createExtendedVp8l();
  writeUint24LittleEndian(vp8xCanvasMismatch, 24, 1598);
  const vp8xReservedBit = createExtendedVp8l();
  vp8xReservedBit[20] |= 0x01;
  const vp8xReservedByte = createExtendedVp8l();
  vp8xReservedByte[21] = 1;
  const vp8xCanvasOverflow = createExtendedVp8l();
  vp8xCanvasOverflow.fill(0xff, 24, 30);
  for (const bytes of [
    createRiff([createChunk("VP8 ", vp8HeaderOnly)]),
    createRiff([createChunk("VP8L", realStaticVp8l().slice(20, 25))]),
    vp8xCanvasMismatch,
    vp8xReservedBit,
    vp8xReservedByte,
    vp8xCanvasOverflow,
    createRiff([
      createChunk("JUNK", new Uint8Array(2)),
      createVp8xChunk(),
      realStaticVp8l().slice(12),
    ]),
    createRiff([
      createChunk("VP8X", new Uint8Array(9)),
      realStaticVp8l().slice(12),
    ]),
  ]) {
    expectMediaFailure(validateProjectMedia({
      catalog,
      sources: sourcesWithGammaBytes(bytes),
    }), ["CONTENT_PROJECT_MEDIA_SIGNATURE"]);
  }
});

test("I-11 RIFF 签名、长度、chunk padding、动画与尺寸反例分别稳定失败", () => {
  const catalog = expectCatalogSuccess(validateProjectCatalog(createCatalogInput()));
  const wrongRiff = realStaticVp8l();
  wrongRiff[0] = 0x58;
  const truncated = realStaticVp8l().slice(0, -2);
  const wrongChunkLength = realStaticVp8l();
  writeUint32LittleEndian(wrongChunkLength, 16, 0xffff_ffff);
  const wrongPadding = realStaticVp8l();
  wrongPadding[wrongPadding.byteLength - 1] = 1;
  for (const bytes of [wrongRiff, truncated, wrongChunkLength, wrongPadding]) {
    expectMediaFailure(validateProjectMedia({
      catalog,
      sources: sourcesWithGammaBytes(bytes),
    }), ["CONTENT_PROJECT_MEDIA_SIGNATURE"]);
  }

  for (const bytes of [
    createAnimatedFlagWebP(),
    createExtendedVp8l([createChunk("ANIM", new Uint8Array(6))]),
    createExtendedVp8l([createChunk("ANMF", new Uint8Array(16))]),
  ]) {
    expectMediaFailure(validateProjectMedia({
      catalog,
      sources: sourcesWithGammaBytes(bytes),
    }), ["CONTENT_PROJECT_MEDIA_ANIMATED"]);
  }

  expectMediaFailure(validateProjectMedia({
    catalog,
    sources: sourcesWithGammaBytes(createWrongWidthWebP()),
  }), ["CONTENT_PROJECT_MEDIA_DIMENSIONS"]);
});

test("I-11 300000 bytes 精确边界通过且 300001 bytes 失败", () => {
  const catalog = expectCatalogSuccess(validateProjectCatalog(createCatalogInput()));
  const exact = createSizedExtendedWebP(300_000);
  expectMediaSuccess(validateProjectMedia({
    catalog,
    sources: sourcesWithGammaBytes(exact),
  }));
  const oversized = concatBytes(exact, new Uint8Array([0]));
  const originalSet = Uint8Array.prototype.set;
  const copiedByteLengths: number[] = [];
  try {
    Uint8Array.prototype.set = function set(
      array: ArrayLike<number>,
      offset?: number,
    ): void {
      copiedByteLengths.push(array.length);
      Reflect.apply(originalSet, this, [array, offset ?? 0]);
    };
    expectMediaFailure(validateProjectMedia({
      catalog,
      sources: sourcesWithGammaBytes(oversized),
    }), ["CONTENT_PROJECT_MEDIA_SIZE"]);
  } finally {
    Uint8Array.prototype.set = originalSet;
  }
  assert.equal(copiedByteLengths.includes(oversized.byteLength), false);
  expectMediaFailure(validateProjectMedia({
    catalog,
    sources: sourcesWithGammaBytes(createSizedExtendedWebP(300_002)),
  }), ["CONTENT_PROJECT_MEDIA_SIZE"]);
});

test("I-11 非已验证 catalog 与任一媒体错误都只返回 issues", () => {
  const catalog = expectCatalogSuccess(validateProjectCatalog(createCatalogInput()));
  const malformed = structuredClone(catalog);
  const projects = malformed.projects as unknown as Array<Record<string, unknown>>;
  const published = projects.find((project) => project.id === "gamma-published");
  assert.ok(published);
  delete published.previewImage;
  expectMediaFailure(validateProjectMedia({catalog: malformed, sources: validMediaSources()}), [
    "CONTENT_PROJECT_MEDIA_CATALOG_INVALID",
  ]);
});

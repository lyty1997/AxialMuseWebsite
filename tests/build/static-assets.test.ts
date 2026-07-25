import assert from "node:assert/strict";
import fs, {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import test from "node:test";
import {
  formatStaticAssetError,
  prepareStaticAssetPlan,
  StaticAssetError,
} from "../../src/build/static-assets/index.js";
import {
  assertStaticAssetPlanInputsCurrent,
  getStaticAssetPlanInputDigest,
} from "../../src/build/static-assets/plan.js";
import {
  readPrivateFileSnapshot,
  scanBuildTree,
} from "../../src/build/static-assets/file-safety.js";
import {
  combineContentBuildInputDigests,
  createContentBuildSealController,
} from "../../src/build/content/build-seal.js";
import type {
  PrepareStaticAssetPlanInput,
  StaticAssetMode,
  StaticAssetPlan,
} from "../../src/build/static-assets/index.js";
import {readBuildContext} from "../../src/build/site-config/index.js";
import type {BuildContext} from "../../src/build/site-config/index.js";
import {validateProjectCatalog} from "../../src/domain/content/index.js";
import type {
  Project,
  ProjectCatalog,
  ProjectCatalogInput,
  RegistryDocumentInput,
} from "../../src/domain/content/index.js";

const PROJECT_CASES = Object.freeze([
  ["draft-project", "draft", 0x11],
  ["planned-project", "planned", 0x22],
  ["published-project", "published", 0x33],
  ["archived-project", "archived", 0x44],
] as const);
const STATIC_BRAND_BYTES = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><path/></svg>\n");
const STATIC_ROBOTS_BYTES = Buffer.from("User-agent: *\nDisallow:\n");
const DRAFT_ARTICLE_BYTES = Uint8Array.from([0xde, 0xad, 0xfa, 0xce, 0x01]);
const DRAFT_ARTICLE_URL = "/writing/draft-entry/assets/private-diagram.png";

type FileSystemOverrides = Partial<Pick<
  typeof fs,
  "closeSync" | "readSync"
>>;

let fileSystemOverridesActive = false;

function withFileSystemOverrides<T>(
  overrides: FileSystemOverrides,
  action: () => T,
): T {
  assert.equal(fileSystemOverridesActive, false);
  const originals: Required<FileSystemOverrides> = {
    closeSync: fs.closeSync,
    readSync: fs.readSync,
  };
  fileSystemOverridesActive = true;
  try {
    Object.assign(fs, overrides);
    syncBuiltinESMExports();
    return action();
  } finally {
    try {
      Object.assign(fs, originals);
      syncBuiltinESMExports();
    } finally {
      fileSystemOverridesActive = false;
    }
  }
}

function captureStaticAssetError(action: () => unknown): StaticAssetError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof StaticAssetError);
    return error;
  }
  assert.fail("expected StaticAssetError");
}

function assertAggregateCause(
  cause: unknown,
  operationError: Error,
  closeError: Error,
): void {
  assert.ok(cause instanceof AggregateError);
  assert.deepEqual(cause.errors, [operationError, closeError]);
  assert.strictEqual(cause.errors[0], operationError);
  assert.strictEqual(cause.errors[1], closeError);
}

function writeUint32LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function staticVp8l(seed: number): Uint8Array {
  const payload = new Uint8Array(6);
  payload[0] = 0x2f;
  const dimensions = (1599) | (999 << 14);
  writeUint32LittleEndian(payload, 1, dimensions);
  payload[5] = seed;
  const bytes = new Uint8Array(12 + 8 + payload.byteLength);
  bytes.set(Buffer.from("RIFF"), 0);
  writeUint32LittleEndian(bytes, 4, bytes.byteLength - 8);
  bytes.set(Buffer.from("WEBP"), 8);
  bytes.set(Buffer.from("VP8L"), 12);
  writeUint32LittleEndian(bytes, 16, payload.byteLength);
  bytes.set(payload, 20);
  return bytes;
}

function privateInlineAssetBytes(length = 9_999): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 31 + 17) % 251;
  }
  return bytes;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function project(
  id: string,
  publicationStatus: Project["publicationStatus"],
  navigationOrder: number,
): Project {
  return {
    id,
    title: `${id} verified title`,
    slug: id,
    navigationOrder,
    summary: `${id} has a sufficiently descriptive and entirely fictional fixture summary.`,
    status: publicationStatus === "archived"
      ? "archived"
      : publicationStatus === "published"
        ? "paused"
        : "active",
    publicationStatus,
    startedAt: "2026-01",
    updatedAt: "2026-07-01",
    repositoryUrl: `https://example.test/repositories/${id}`,
    productionBranch: "main",
    showcaseMode: "repository",
    relatedWriting: [],
    writingModules: [],
    previewImage: {
      sourcePath: `projects/${id}/${id}.webp`,
      width: 1600,
      height: 1000,
      alt: `${id} fixture showing a verified interface state`,
    },
    source: [`https://example.test/evidence/${id}`],
  };
}

function createCatalog(
  projects: readonly Project[] = PROJECT_CASES.map(([id, publicationStatus], index) => (
    project(id, publicationStatus, index + 1)
  )),
): ProjectCatalog {
  const input: ProjectCatalogInput = {
    projects: {
      sourcePath: "docs/contracts/projects.json",
      value: {
        version: "0.3.0",
        kind: "axial_muse_projects",
        status: "active",
        owner: "AxialMuseWebsite",
        lifecycleStatusValues: ["active", "paused", "completed", "archived"],
        publicationStatusValues: ["draft", "planned", "published", "archived"],
        showcaseModes: ["repository", "repository-and-video"],
        projects: projects.map(({relatedWriting: _relatedWriting, ...entry}) => ({...entry})),
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
        statusValues: ["planned", "provisioning", "live", "paused", "retired"],
        deliveryModes: ["static"],
        reservedSubdomains: [
          "www", "api", "admin", "auth", "account", "assets", "cdn", "dev",
          "docs", "mail", "preview", "staging", "static", "status", "support",
        ],
        experiences: [],
      },
    },
    projectSources: projects
      .filter((entry) => ["published", "archived"].includes(entry.publicationStatus))
      .map((entry) => ({
        sourcePath: `site-content/projects/${entry.id}/index.md`,
        isSymbolicLink: false,
        isRealPathWithinRoot: true,
        frontMatter: {},
        content: "## Fixture\n\nVerified fixture body with traceable evidence.\n",
      })),
  };
  const result = validateProjectCatalog(input);
  if (!result.ok) assert.fail(`catalog fixture validation failed: ${JSON.stringify(result.issues)}`);
  return result.value;
}

function registryDocument(
  entries: readonly Readonly<{sourcePath: string; role: string}>[] = [
    {sourcePath: "assets/brand/logo.svg", role: "brand"},
    {sourcePath: "robots.txt", role: "operational"},
  ],
): RegistryDocumentInput {
  return {
    sourcePath: "docs/contracts/static-public-assets.json",
    value: deepFreeze({
      version: "0.1.0",
      kind: "axial_muse_static_public_assets",
      status: "active",
      owner: "AxialMuseWebsite",
      roleValues: ["brand", "operational"],
      assets: entries.map((entry) => ({...entry})),
    }),
  };
}

function writeFixture(root: string, relativePath: string, bytes: Uint8Array | string): void {
  const path = resolve(root, relativePath);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, bytes);
}

function createRepositoryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-static-assets-source-"));
  chmodSync(root, 0o700);
  for (const [id, , seed] of PROJECT_CASES) {
    writeFixture(root, `site-assets/projects/${id}/${id}.webp`, staticVp8l(seed));
  }
  writeFixture(root, "static-public/assets/brand/logo.svg", STATIC_BRAND_BYTES);
  writeFixture(root, "static-public/robots.txt", STATIC_ROBOTS_BYTES);
  return root;
}

function createBuildContext(mode: StaticAssetMode): Readonly<{
  context: BuildContext;
  root: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-build-"));
  chmodSync(root, 0o700);
  mkdirSync(resolve(root, "static"), {mode: 0o700});
  chmodSync(resolve(root, "static"), 0o700);
  const owner = mode === "production" ? "a".repeat(64) : "b".repeat(64);
  writeFileSync(
    resolve(root, ".axial-muse-build-owner"),
    `${mode}:${owner}\n`,
    {encoding: "utf8", mode: 0o600},
  );
  chmodSync(resolve(root, ".axial-muse-build-owner"), 0o600);
  return {
    root,
    context: readBuildContext({
      AXIAL_MUSE_BUILD_MODE: mode,
      AXIAL_MUSE_BUILD_ROOT: root,
      AXIAL_MUSE_BUILD_OWNER: owner,
    }),
  };
}

function planInput(
  root: string,
  mode: StaticAssetMode,
  registry = registryDocument(),
): PrepareStaticAssetPlanInput {
  return {
    mode,
    repositoryRoot: root,
    catalog: createCatalog(),
    staticPublicRegistry: registry,
    unpublishedAssets: [{
      sourcePath: "site-content/writing/draft-entry/assets/private-diagram.png",
      publicPath: DRAFT_ARTICLE_URL,
      bytes: new Uint8Array(DRAFT_ARTICLE_BYTES),
    }],
  };
}

function hasStaticAssetCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof StaticAssetError && error.code === code;
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) walk(path);
      else files.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(root);
  return files.sort();
}

function copyTreeBytes(source: string, target: string): void {
  mkdirSync(target, {recursive: true});
  for (const relativePath of listFiles(source)) {
    writeFixture(target, relativePath, readFileSync(resolve(source, relativePath)));
  }
}

function publicPreviewUrls(plan: StaticAssetPlan): string[] {
  return plan.manifest.files.flatMap((file) => (
    file.kind === "project-preview" ? [file.publicUrl] : []
  ));
}

function inputDigest(input: PrepareStaticAssetPlanInput): string {
  const plan = prepareStaticAssetPlan(input);
  try {
    return getStaticAssetPlanInputDigest(plan);
  } finally {
    plan.dispose();
  }
}

function hasContentBuildCode(code: string): (error: unknown) => boolean {
  return (error) => (
    error instanceof Error
    && "code" in error
    && error.code === code
  );
}

function createSealControlFixture(
  repositoryRoot: string,
  owner: string,
): Readonly<{
  transactionRoot: string;
  environment: NodeJS.ProcessEnv;
}> {
  const transactionRoot = mkdtempSync(join(
    tmpdir(),
    "axial-muse-build-transaction-",
  ));
  chmodSync(transactionRoot, 0o700);
  writeFileSync(resolve(repositoryRoot, ".axial-muse-build.lock"), `${owner}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(resolve(repositoryRoot, ".axial-muse-build.lock"), 0o600);
  writeFileSync(
    resolve(transactionRoot, ".axial-muse-build-transaction-owner"),
    `production:${owner}\n`,
    {encoding: "utf8", mode: 0o600},
  );
  chmodSync(
    resolve(transactionRoot, ".axial-muse-build-transaction-owner"),
    0o600,
  );
  return Object.freeze({
    transactionRoot,
    environment: {AXIAL_MUSE_BUILD_TRANSACTION_ROOT: transactionRoot},
  });
}

function writeSsrHtml(buildRoot: string, urls: readonly string[]): void {
  writeFixture(
    buildRoot,
    "index.html",
    `<!doctype html><html><body>${urls.map((url) => `<img src="${url}" alt="fixture">`).join("")}</body></html>`,
  );
}

function materializedProduction(
  root: string,
  input: PrepareStaticAssetPlanInput = planInput(root, "production"),
): Readonly<{
  plan: StaticAssetPlan;
  contextRoot: string;
  staticRoot: string;
}> {
  const plan = prepareStaticAssetPlan(input);
  const buildContext = createBuildContext("production");
  plan.materialize(buildContext.context);
  return {
    plan,
    contextRoot: buildContext.root,
    staticRoot: buildContext.context.staticDirectory,
  };
}

test("CODE-003 素材源安全读取保留 operation 与 close 双故障并清零失败快照", () => {
  for (const failureMode of [
    "success",
    "operation-only",
    "close-only",
    "dual",
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "axial-muse-source-read-"));
    chmodSync(root, 0o700);
    const absolutePath = resolve(root, "asset.bin");
    const expectedBytes = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
    writeFileSync(absolutePath, expectedBytes, {mode: 0o600});
    const operationError = new Error(`fixture ${failureMode} read failure`);
    const closeError = new Error(`fixture ${failureMode} close failure`);
    const realReadSync = fs.readSync;
    const realCloseSync = fs.closeSync;
    let capturedSnapshot: Uint8Array | undefined;
    let closeCalls = 0;
    let returned = false;
    try {
      const resultOrError = withFileSystemOverrides({
        readSync: ((
          descriptor: number,
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          capturedSnapshot = buffer;
          if (failureMode === "operation-only" || failureMode === "dual") {
            buffer.fill(0xa5);
            throw operationError;
          }
          return realReadSync(descriptor, buffer, offset, length, position);
        }) as typeof fs.readSync,
        closeSync: ((descriptor: number) => {
          closeCalls += 1;
          realCloseSync(descriptor);
          if (failureMode === "close-only" || failureMode === "dual") {
            throw closeError;
          }
        }) as typeof fs.closeSync,
      }, () => {
        if (failureMode === "success") {
          const value = readPrivateFileSnapshot({
            absolutePath,
            realRoot: root,
            sourcePath: "fixture/asset.bin",
            maximumBytes: expectedBytes.byteLength,
          });
          returned = true;
          return value;
        }
        return captureStaticAssetError(() => readPrivateFileSnapshot({
          absolutePath,
          realRoot: root,
          sourcePath: "fixture/asset.bin",
          maximumBytes: expectedBytes.byteLength,
        }));
      });

      assert.equal(closeCalls, 1, failureMode);
      assert.ok(capturedSnapshot);
      if (failureMode === "success") {
        assert.equal(returned, true);
        assert.deepEqual(resultOrError, expectedBytes);
        assert.strictEqual(resultOrError, capturedSnapshot);
        continue;
      }

      assert.equal(returned, false);
      assert.ok(resultOrError instanceof StaticAssetError);
      assert.equal(resultOrError.sourcePath, "fixture/asset.bin");
      const formattedError = formatStaticAssetError(resultOrError);
      assert.equal(formattedError.includes(operationError.message), false);
      assert.equal(formattedError.includes(closeError.message), false);
      assert.deepEqual(capturedSnapshot, new Uint8Array(expectedBytes.byteLength));
      if (failureMode === "operation-only") {
        assert.equal(resultOrError.code, "STATIC_ASSET_IO");
        assert.strictEqual(resultOrError.cause, operationError);
      } else if (failureMode === "close-only") {
        assert.equal(resultOrError.code, "STATIC_ASSET_SOURCE_CLOSE");
        assert.strictEqual(resultOrError.cause, closeError);
      } else {
        assert.equal(resultOrError.code, "STATIC_ASSET_SOURCE_CLOSE");
        assertAggregateCause(resultOrError.cause, operationError, closeError);
      }
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  }
});

test("CODE-003 production 制品扫描保留 operation 与 close 双故障且不返回部分证据", () => {
  for (const failureMode of [
    "success",
    "operation-only",
    "close-only",
    "dual",
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "axial-muse-build-read-"));
    chmodSync(root, 0o700);
    const artifactBytes = Uint8Array.from([0x51, 0x52, 0x53, 0x54]);
    writeFileSync(resolve(root, "artifact.bin"), artifactBytes, {mode: 0o600});
    const operationError = new Error(`fixture ${failureMode} read failure`);
    const closeError = new Error(`fixture ${failureMode} close failure`);
    const realReadSync = fs.readSync;
    const realCloseSync = fs.closeSync;
    let readCalls = 0;
    let closeCalls = 0;
    let returned = false;
    try {
      const resultOrError = withFileSystemOverrides({
        readSync: ((
          descriptor: number,
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          readCalls += 1;
          if (failureMode === "operation-only" || failureMode === "dual") {
            throw operationError;
          }
          return realReadSync(descriptor, buffer, offset, length, position);
        }) as typeof fs.readSync,
        closeSync: ((descriptor: number) => {
          closeCalls += 1;
          realCloseSync(descriptor);
          if (failureMode === "close-only" || failureMode === "dual") {
            throw closeError;
          }
        }) as typeof fs.closeSync,
      }, () => {
        if (failureMode === "success") {
          const value = scanBuildTree(root, [], [], []);
          returned = true;
          return value;
        }
        return captureStaticAssetError(() => scanBuildTree(root, [], [], []));
      });

      if (failureMode === "success") {
        assert.equal(returned, true);
        assert.equal(readCalls, 2);
        assert.equal(closeCalls, 2);
        assert.ok(!(resultOrError instanceof StaticAssetError));
        assert.deepEqual(resultOrError.files, [{
          relativePath: "artifact.bin",
          byteLength: artifactBytes.byteLength,
          sha256: "3205ec026521f6eef80fa45778082d83e4de532c57f0861677cb30c394c11400",
        }]);
        assert.equal(resultOrError.hasLeakedToken, false);
        assert.equal(resultOrError.ssrImageReferenceIndexes.size, 0);
        continue;
      }

      assert.equal(returned, false);
      assert.equal(readCalls, 1);
      assert.equal(closeCalls, 1);
      assert.ok(resultOrError instanceof StaticAssetError);
      assert.equal(resultOrError.sourcePath, "build/artifact.bin");
      const formattedError = formatStaticAssetError(resultOrError);
      assert.equal(formattedError.includes(operationError.message), false);
      assert.equal(formattedError.includes(closeError.message), false);
      if (failureMode === "operation-only") {
        assert.equal(resultOrError.code, "STATIC_ASSET_IO");
        assert.strictEqual(resultOrError.cause, operationError);
      } else if (failureMode === "close-only") {
        assert.equal(resultOrError.code, "STATIC_ASSET_BUILD_CLOSE");
        assert.strictEqual(resultOrError.cause, closeError);
      } else {
        assert.equal(resultOrError.code, "STATIC_ASSET_BUILD_CLOSE");
        assertAggregateCause(resultOrError.cause, operationError, closeError);
      }
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  }
});

test("I-12 静态输入摘要双模式确定并绑定字节、路径与可见性处置", () => {
  const repositoryRoot = createRepositoryFixture();
  try {
    const productionDigest = inputDigest(planInput(repositoryRoot, "production"));
    const repeatedProductionDigest = inputDigest(planInput(repositoryRoot, "production"));
    const previewDigest = inputDigest(planInput(repositoryRoot, "preview"));
    assert.match(productionDigest, /^[0-9a-f]{64}$/u);
    assert.equal(repeatedProductionDigest, productionDigest);
    assert.notEqual(previewDigest, productionDigest);

    const plannedPath = resolve(
      repositoryRoot,
      "site-assets/projects/planned-project/planned-project.webp",
    );
    writeFileSync(plannedPath, staticVp8l(0x72));
    const changedBytesDigest = inputDigest(planInput(repositoryRoot, "production"));
    assert.notEqual(changedBytesDigest, productionDigest);
    writeFileSync(plannedPath, staticVp8l(0x22));
    assert.equal(inputDigest(planInput(repositoryRoot, "production")), productionDigest);

    const visibilityProjects = PROJECT_CASES.map(([
      id,
      publicationStatus,
    ], index) => project(
      id,
      id === "planned-project" ? "published" : publicationStatus,
      index + 1,
    ));
    const visibilityDigest = inputDigest({
      ...planInput(repositoryRoot, "production"),
      catalog: createCatalog(visibilityProjects),
    });
    assert.notEqual(visibilityDigest, productionDigest);

    renameSync(
      resolve(repositoryRoot, "static-public/assets/brand/logo.svg"),
      resolve(repositoryRoot, "static-public/assets/brand/mark.svg"),
    );
    const changedPathDigest = inputDigest(planInput(
      repositoryRoot,
      "production",
      registryDocument([
        {sourcePath: "assets/brand/mark.svg", role: "brand"},
        {sourcePath: "robots.txt", role: "operational"},
      ]),
    ));
    assert.notEqual(changedPathDigest, productionDigest);

    const publicPlan = prepareStaticAssetPlan(planInput(repositoryRoot, "production", registryDocument([
      {sourcePath: "assets/brand/mark.svg", role: "brand"},
      {sourcePath: "robots.txt", role: "operational"},
    ])));
    try {
      assert.equal(Object.hasOwn(publicPlan, "inputDigest"), false);
    } finally {
      publicPlan.dispose();
    }
    assert.throws(
      () => getStaticAssetPlanInputDigest(Object.freeze({}) as StaticAssetPlan),
      hasStaticAssetCode("STATIC_ASSET_PLAN_PROVENANCE"),
    );
  } finally {
    rmSync(repositoryRoot, {recursive: true, force: true});
  }
});

test("E-016 build/check 间未发布预览 A→B 时旧 A 候选被 seal 拒绝且旧 build 不变", () => {
  const repositoryRoot = createRepositoryFixture();
  const buildContext = createBuildContext("production");
  const checkContext = createBuildContext("production");
  const owner = "9".repeat(64);
  const contentDigest = "8".repeat(64);
  const control = createSealControlFixture(repositoryRoot, owner);
  let buildPlan: StaticAssetPlan | undefined;
  let checkPlan: StaticAssetPlan | undefined;
  try {
    writeFixture(repositoryRoot, "build/identity.txt", "old-build\n");
    const plannedSource = resolve(
      repositoryRoot,
      "site-assets/projects/planned-project/planned-project.webp",
    );
    const oldPreviewBytes = readFileSync(plannedSource);
    buildPlan = prepareStaticAssetPlan(planInput(repositoryRoot, "production"));
    const buildStaticDigest = getStaticAssetPlanInputDigest(buildPlan);
    buildPlan.materialize(buildContext.context);

    const candidate = resolve(repositoryRoot, "candidate-artifact");
    copyTreeBytes(buildContext.context.staticDirectory, candidate);
    writeSsrHtml(candidate, publicPreviewUrls(buildPlan));
    writeFixture(candidate, "leaked-old-planned-preview.bin", oldPreviewBytes);
    createContentBuildSealController({
      repositoryRoot,
      mode: "production",
      owner,
      phase: "build",
      inputDigest: combineContentBuildInputDigests(
        contentDigest,
        buildStaticDigest,
      ),
      environment: control.environment,
      assertInputsCurrent() {},
    }).write();

    writeFileSync(plannedSource, staticVp8l(0x73));
    const preparedCheckPlan = prepareStaticAssetPlan(planInput(
      repositoryRoot,
      "production",
    ));
    checkPlan = preparedCheckPlan;
    const checkStaticDigest = getStaticAssetPlanInputDigest(preparedCheckPlan);
    assert.notEqual(checkStaticDigest, buildStaticDigest);
    preparedCheckPlan.materialize(checkContext.context);

    assert.doesNotThrow(() => preparedCheckPlan.assertProductionBuild(candidate));
    const checker = createContentBuildSealController({
      repositoryRoot,
      mode: "production",
      owner,
      phase: "check",
      inputDigest: combineContentBuildInputDigests(
        contentDigest,
        checkStaticDigest,
      ),
      environment: control.environment,
      assertInputsCurrent() {},
    });
    assert.throws(
      () => checker.assert(),
      hasContentBuildCode("CONTENT_INPUT_SEAL"),
    );
    assert.equal(
      readFileSync(resolve(repositoryRoot, "build/identity.txt"), "utf8"),
      "old-build\n",
    );
    assert.deepEqual(
      readFileSync(resolve(candidate, "leaked-old-planned-preview.bin")),
      oldPreviewBytes,
    );
  } finally {
    buildPlan?.dispose();
    checkPlan?.dispose();
    rmSync(buildContext.root, {recursive: true, force: true});
    rmSync(checkContext.root, {recursive: true, force: true});
    rmSync(control.transactionRoot, {recursive: true, force: true});
    rmSync(repositoryRoot, {recursive: true, force: true});
  }
});

test("E-016 final verify 建 plan 后物理静态树增删改均由同次 seal 断言失败关闭", () => {
  const scenarios = [
    ["改字节", (repositoryRoot: string) => {
      writeFileSync(
        resolve(repositoryRoot, "static-public/robots.txt"),
        "User-agent: *\nDisallow: /changed\n",
      );
    }],
    ["增成员", (repositoryRoot: string) => {
      writeFixture(repositoryRoot, "static-public/unregistered.txt", "unexpected\n");
    }],
    ["删成员", (repositoryRoot: string) => {
      unlinkSync(resolve(repositoryRoot, "static-public/assets/brand/logo.svg"));
    }],
  ] as const;

  for (const [label, mutate] of scenarios) {
    const repositoryRoot = createRepositoryFixture();
    const buildContext = createBuildContext("production");
    const verifyContext = createBuildContext("production");
    const owner = "7".repeat(64);
    const contentDigest = "6".repeat(64);
    const control = createSealControlFixture(repositoryRoot, owner);
    let buildPlan: StaticAssetPlan | undefined;
    let verifyPlan: StaticAssetPlan | undefined;
    try {
      writeFixture(repositoryRoot, "build/identity.txt", "old-build\n");
      const oldBuildPath = resolve(repositoryRoot, "build/identity.txt");
      const oldBuildInode = lstatSync(oldBuildPath).ino;
      const preparedBuildPlan = prepareStaticAssetPlan(planInput(
        repositoryRoot,
        "production",
      ));
      buildPlan = preparedBuildPlan;
      const buildStaticDigest = getStaticAssetPlanInputDigest(preparedBuildPlan);
      preparedBuildPlan.materialize(buildContext.context);
      createContentBuildSealController({
        repositoryRoot,
        mode: "production",
        owner,
        phase: "build",
        inputDigest: combineContentBuildInputDigests(
          contentDigest,
          buildStaticDigest,
        ),
        environment: control.environment,
        assertInputsCurrent() {
          assertStaticAssetPlanInputsCurrent(preparedBuildPlan);
        },
      }).write();

      const preparedVerifyPlan = prepareStaticAssetPlan(planInput(
        repositoryRoot,
        "production",
      ));
      verifyPlan = preparedVerifyPlan;
      const verifyStaticDigest = getStaticAssetPlanInputDigest(preparedVerifyPlan);
      assert.equal(verifyStaticDigest, buildStaticDigest, label);
      preparedVerifyPlan.materialize(verifyContext.context);
      let contentCurrentnessChecks = 0;
      const checker = createContentBuildSealController({
        repositoryRoot,
        mode: "production",
        owner,
        phase: "verify",
        inputDigest: combineContentBuildInputDigests(
          contentDigest,
          verifyStaticDigest,
        ),
        environment: control.environment,
        assertInputsCurrent() {
          contentCurrentnessChecks += 1;
          assertStaticAssetPlanInputsCurrent(preparedVerifyPlan);
        },
      });

      mutate(repositoryRoot);
      assert.throws(
        () => checker.assert(),
        hasStaticAssetCode("STATIC_ASSET_SOURCE_DRIFT"),
        label,
      );
      assert.equal(contentCurrentnessChecks, 1, label);
      assert.equal(
        readFileSync(oldBuildPath, "utf8"),
        "old-build\n",
        label,
      );
      assert.equal(lstatSync(oldBuildPath).ino, oldBuildInode, label);
    } finally {
      buildPlan?.dispose();
      verifyPlan?.dispose();
      rmSync(buildContext.root, {recursive: true, force: true});
      rmSync(verifyContext.root, {recursive: true, force: true});
      rmSync(control.transactionRoot, {recursive: true, force: true});
      rmSync(repositoryRoot, {recursive: true, force: true});
    }
  }
});

test("I-12 production/preview 从同一非空源生成隔离且按 publicationStatus 选择的确定白名单", () => {
  const repositoryRoot = createRepositoryFixture();
  const productionContext = createBuildContext("production");
  const previewContext = createBuildContext("preview");
  try {
    const production = prepareStaticAssetPlan(planInput(repositoryRoot, "production"));
    const preview = prepareStaticAssetPlan(planInput(repositoryRoot, "preview"));
    production.materialize(productionContext.context);
    preview.materialize(previewContext.context);

    assert.deepEqual(publicPreviewUrls(production), [
      "/assets/projects/archived-project/archived-project.webp",
      "/assets/projects/published-project/published-project.webp",
    ]);
    assert.deepEqual(publicPreviewUrls(preview), [
      "/assets/projects/archived-project/archived-project.webp",
      "/assets/projects/draft-project/draft-project.webp",
      "/assets/projects/planned-project/planned-project.webp",
      "/assets/projects/published-project/published-project.webp",
    ]);
    assert.deepEqual(listFiles(productionContext.context.staticDirectory), [
      "assets/brand/logo.svg",
      "assets/projects/archived-project/archived-project.webp",
      "assets/projects/published-project/published-project.webp",
      "robots.txt",
    ]);
    assert.deepEqual(listFiles(previewContext.context.staticDirectory), [
      "assets/brand/logo.svg",
      "assets/projects/archived-project/archived-project.webp",
      "assets/projects/draft-project/draft-project.webp",
      "assets/projects/planned-project/planned-project.webp",
      "assets/projects/published-project/published-project.webp",
      "robots.txt",
    ]);
    assert.notEqual(
      lstatSync(productionContext.context.staticDirectory).ino,
      lstatSync(previewContext.context.staticDirectory).ino,
    );
    assert.ok(Object.isFrozen(production));
    assert.ok(Object.isFrozen(production.manifest));
    assert.ok(Object.isFrozen(production.manifest.files));
    assert.ok(production.manifest.files.every((file) => !Object.hasOwn(file, "bytes")));
    assert.ok(production.manifest.excludedFiles.every((file) => !Object.hasOwn(file, "sha256")));
    assert.throws(
      () => Object.defineProperty(production, "manifest", {value: preview.manifest}),
      TypeError,
    );
  } finally {
    rmSync(repositoryRoot, {recursive: true, force: true});
    rmSync(productionContext.root, {recursive: true, force: true});
    rmSync(previewContext.root, {recursive: true, force: true});
  }
});

test("I-12 计划封存同次读取字节，源路径与调用方 Buffer 后续变化不改变物化结果", () => {
  const repositoryRoot = createRepositoryFixture();
  const context = createBuildContext("production");
  const input = planInput(repositoryRoot, "production");
  const privateInput = input.unpublishedAssets?.[0]?.bytes;
  assert.ok(privateInput);
  const original = readFileSync(
    resolve(repositoryRoot, "site-assets/projects/published-project/published-project.webp"),
  );
  try {
    const plan = prepareStaticAssetPlan(input);
    writeFileSync(
      resolve(repositoryRoot, "site-assets/projects/published-project/published-project.webp"),
      staticVp8l(0xfe),
    );
    privateInput.fill(0);
    plan.materialize(context.context);
    assert.deepEqual(
      readFileSync(resolve(
        context.context.staticDirectory,
        "assets/projects/published-project/published-project.webp",
      )),
      original,
    );
    assert.throws(
      () => plan.materialize(context.context),
      hasStaticAssetCode("STATIC_ASSET_PLAN_CONSUMED"),
    );
  } finally {
    rmSync(repositoryRoot, {recursive: true, force: true});
    rmSync(context.root, {recursive: true, force: true});
  }
});

test("I-12 拒绝非空目标、模式错配与原素材目录直连且保留原现场", async (t) => {
  await t.test("非空目标 sentinel 不被清理", () => {
    const root = createRepositoryFixture();
    const context = createBuildContext("production");
    const sentinelPath = resolve(context.context.staticDirectory, "sentinel.txt");
    writeFileSync(sentinelPath, "keep\n");
    const sentinelInode = lstatSync(sentinelPath).ino;
    const plan = prepareStaticAssetPlan(planInput(root, "production"));
    try {
      assert.throws(
        () => plan.materialize(context.context),
        hasStaticAssetCode("STATIC_ASSET_TARGET_NOT_EMPTY"),
      );
      assert.equal(readFileSync(sentinelPath, "utf8"), "keep\n");
      assert.equal(lstatSync(sentinelPath).ino, sentinelInode);
    } finally {
      rmSync(root, {recursive: true, force: true});
      rmSync(context.root, {recursive: true, force: true});
    }
  });

  await t.test("模式错配 sentinel 不被清理", () => {
    const root = createRepositoryFixture();
    const context = createBuildContext("preview");
    const sentinelPath = resolve(context.context.staticDirectory, "sentinel.txt");
    writeFileSync(sentinelPath, "keep-mode\n");
    const sentinelInode = lstatSync(sentinelPath).ino;
    const plan = prepareStaticAssetPlan(planInput(root, "production"));
    try {
      assert.throws(
        () => plan.materialize(context.context),
        hasStaticAssetCode("STATIC_ASSET_MODE_MISMATCH"),
      );
      assert.equal(readFileSync(sentinelPath, "utf8"), "keep-mode\n");
      assert.equal(lstatSync(sentinelPath).ino, sentinelInode);
    } finally {
      rmSync(root, {recursive: true, force: true});
      rmSync(context.root, {recursive: true, force: true});
    }
  });

  await t.test("原素材目录不能伪装成临时 static 目标", () => {
    const root = createRepositoryFixture();
    const context = createBuildContext("production");
    const sourcePath = resolve(
      root,
      "site-assets/projects/published-project/published-project.webp",
    );
    const sourceBefore = readFileSync(sourcePath);
    const plan = prepareStaticAssetPlan(planInput(root, "production"));
    try {
      assert.throws(
        () => plan.materialize({
          ...context.context,
          staticDirectory: resolve(root, "site-assets"),
        }),
        hasStaticAssetCode("STATIC_ASSET_MATERIALIZE"),
      );
      assert.deepEqual(readFileSync(sourcePath), sourceBefore);
    } finally {
      rmSync(root, {recursive: true, force: true});
      rmSync(context.root, {recursive: true, force: true});
    }
  });

  await t.test("dispose 幂等且销毁后不可物化", () => {
    const root = createRepositoryFixture();
    const context = createBuildContext("production");
    const plan = prepareStaticAssetPlan(planInput(root, "production"));
    try {
      plan.dispose();
      plan.dispose();
      assert.throws(
        () => plan.materialize(context.context),
        hasStaticAssetCode("STATIC_ASSET_PLAN_CONSUMED"),
      );
      assert.deepEqual(readdirSync(context.context.staticDirectory), []);
    } finally {
      rmSync(root, {recursive: true, force: true});
      rmSync(context.root, {recursive: true, force: true});
    }
  });
});

test("I-12 static-public 登记闭合、角色路径与跨类别同字节均失败关闭且不写目标", async (t) => {
  await t.test("未登记文件", () => {
    const root = createRepositoryFixture();
    writeFixture(root, "static-public/assets/brand/unregistered.svg", "fixture\n");
    try {
      assert.throws(
        () => prepareStaticAssetPlan(planInput(root, "production")),
        hasStaticAssetCode("STATIC_ASSET_PUBLIC_UNREGISTERED"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  await t.test("登记文件缺失", () => {
    const root = createRepositoryFixture();
    unlinkSync(resolve(root, "static-public/robots.txt"));
    try {
      assert.throws(
        () => prepareStaticAssetPlan(planInput(root, "production")),
        hasStaticAssetCode("STATIC_ASSET_PUBLIC_MISSING"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  await t.test("项目素材误放 static-public", () => {
    const root = createRepositoryFixture();
    writeFixture(root, "static-public/assets/projects/private.webp", staticVp8l(0x88));
    try {
      const registry = registryDocument([
        {sourcePath: "assets/brand/logo.svg", role: "brand"},
        {sourcePath: "assets/projects/private.webp", role: "brand"},
        {sourcePath: "robots.txt", role: "operational"},
      ]);
      assert.throws(
        () => prepareStaticAssetPlan(planInput(root, "production", registry)),
        hasStaticAssetCode("STATIC_ASSET_PUBLIC_RESERVED_PATH"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  await t.test("角色与路径不匹配", () => {
    const root = createRepositoryFixture();
    try {
      const registry = registryDocument([
        {sourcePath: "assets/brand/logo.svg", role: "operational"},
        {sourcePath: "robots.txt", role: "operational"},
      ]);
      assert.throws(
        () => prepareStaticAssetPlan(planInput(root, "production", registry)),
        hasStaticAssetCode("STATIC_ASSET_PUBLIC_ROLE_PATH"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  await t.test("与项目素材同字节", () => {
    const root = createRepositoryFixture();
    writeFileSync(
      resolve(root, "static-public/assets/brand/logo.svg"),
      staticVp8l(0x33),
    );
    try {
      assert.throws(
        () => prepareStaticAssetPlan(planInput(root, "production")),
        hasStaticAssetCode("STATIC_ASSET_PUBLIC_BYTE_DUPLICATE"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});

test("I-12 .well-known operational 素材完成登记、物化与 production 检查闭环", () => {
  const root = createRepositoryFixture();
  const context = createBuildContext("production");
  const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-production-build-"));
  chmodSync(buildRoot, 0o700);
  writeFixture(root, "static-public/.well-known/security.txt", "Contact: mailto:security@example.test\n");
  const registry = registryDocument([
    {sourcePath: ".well-known/security.txt", role: "operational"},
    {sourcePath: "assets/brand/logo.svg", role: "brand"},
    {sourcePath: "robots.txt", role: "operational"},
  ]);
  try {
    const plan = prepareStaticAssetPlan(planInput(root, "production", registry));
    plan.materialize(context.context);
    copyTreeBytes(context.context.staticDirectory, buildRoot);
    writeSsrHtml(buildRoot, publicPreviewUrls(plan));
    assert.doesNotThrow(() => plan.assertProductionBuild(buildRoot));
    assert.deepEqual(
      readFileSync(resolve(buildRoot, ".well-known/security.txt"), "utf8"),
      "Contact: mailto:security@example.test\n",
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
    rmSync(context.root, {recursive: true, force: true});
    rmSync(buildRoot, {recursive: true, force: true});
  }
});

test("I-12 source symlink、hardlink 与超限稀疏文件在危险读取前失败", async (t) => {
  await t.test("符号链接", () => {
    const root = createRepositoryFixture();
    const path = resolve(root, "site-assets/projects/draft-project/draft-project.webp");
    unlinkSync(path);
    symlinkSync(resolve(root, "site-assets/projects/published-project/published-project.webp"), path);
    try {
      assert.throws(
        () => prepareStaticAssetPlan(planInput(root, "production")),
        hasStaticAssetCode("STATIC_ASSET_MEDIA_VALIDATION"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  await t.test("真实路径逃逸素材根", () => {
    const root = createRepositoryFixture();
    const outside = mkdtempSync(join(tmpdir(), "axial-muse-static-assets-outside-"));
    chmodSync(outside, 0o700);
    const outsideFile = resolve(outside, "outside.webp");
    writeFileSync(outsideFile, staticVp8l(0x90));
    const path = resolve(root, "site-assets/projects/draft-project/draft-project.webp");
    unlinkSync(path);
    symlinkSync(outsideFile, path);
    try {
      assert.throws(
        () => prepareStaticAssetPlan(planInput(root, "production")),
        hasStaticAssetCode("STATIC_ASSET_MEDIA_VALIDATION"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
      rmSync(outside, {recursive: true, force: true});
    }
  });

  await t.test("硬链接", () => {
    const root = createRepositoryFixture();
    const source = resolve(root, "site-assets/projects/draft-project/draft-project.webp");
    const target = resolve(root, "site-assets/projects/planned-project/planned-project.webp");
    unlinkSync(target);
    linkSync(source, target);
    try {
      assert.throws(
        () => prepareStaticAssetPlan(planInput(root, "production")),
        hasStaticAssetCode("STATIC_ASSET_SOURCE_HARDLINK"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  await t.test("非普通文件叶子", () => {
    const root = createRepositoryFixture();
    const path = resolve(root, "site-assets/projects/draft-project/draft-project.webp");
    unlinkSync(path);
    mkdirSync(path, {mode: 0o700});
    try {
      assert.throws(
        () => prepareStaticAssetPlan(planInput(root, "production")),
        hasStaticAssetCode("STATIC_ASSET_MEDIA_VALIDATION"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  await t.test("超限稀疏文件", () => {
    const root = createRepositoryFixture();
    truncateSync(
      resolve(root, "site-assets/projects/draft-project/draft-project.webp"),
      300_001,
    );
    try {
      assert.throws(
        () => prepareStaticAssetPlan(planInput(root, "production")),
        hasStaticAssetCode("STATIC_ASSET_SOURCE_SIZE"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});

test("I-12 dangling 根链接与伪造 catalog provenance 均失败关闭", async (t) => {
  const planned = project("root-check", "planned", 1);
  const {previewImage: _previewImage, ...withoutPreview} = planned;
  const catalog = createCatalog([withoutPreview]);

  await t.test("dangling site-assets 根", () => {
    const root = mkdtempSync(join(tmpdir(), "axial-muse-static-assets-source-"));
    chmodSync(root, 0o700);
    symlinkSync(resolve(root, "missing-site-assets"), resolve(root, "site-assets"));
    try {
      assert.throws(
        () => prepareStaticAssetPlan({
          mode: "production",
          repositoryRoot: root,
          catalog,
          staticPublicRegistry: registryDocument([]),
        }),
        hasStaticAssetCode("STATIC_ASSET_SOURCE_DIRECTORY"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  await t.test("dangling static-public 根", () => {
    const root = mkdtempSync(join(tmpdir(), "axial-muse-static-assets-source-"));
    chmodSync(root, 0o700);
    symlinkSync(resolve(root, "missing-static-public"), resolve(root, "static-public"));
    try {
      assert.throws(
        () => prepareStaticAssetPlan({
          mode: "production",
          repositoryRoot: root,
          catalog,
          staticPublicRegistry: registryDocument([]),
        }),
        hasStaticAssetCode("STATIC_ASSET_SOURCE_DIRECTORY"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  await t.test("结构相同但未由 validateProjectCatalog 产生的 catalog", () => {
    const root = createRepositoryFixture();
    const forged = deepFreeze(
      JSON.parse(JSON.stringify(createCatalog())) as ProjectCatalog,
    );
    try {
      assert.throws(
        () => prepareStaticAssetPlan({...planInput(root, "production"), catalog: forged}),
        hasStaticAssetCode("STATIC_ASSET_CATALOG"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});

test("I-12 项目预览与未发布正文同字节在 production/preview 都失败", () => {
  for (const mode of ["production", "preview"] as const) {
    const root = createRepositoryFixture();
    try {
      assert.throws(
        () => prepareStaticAssetPlan({
          ...planInput(root, mode),
          unpublishedAssets: [{
            sourcePath: "site-content/writing/private/assets/copied-preview.webp",
            publicPath: "/writing/private/assets/copied-preview.webp",
            bytes: staticVp8l(0x11),
          }],
        }),
        hasStaticAssetCode("STATIC_ASSET_SOURCE_BYTE_DUPLICATE"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  }
});

test("I-12 注册表乱序等价，未知字段与重复登记失败关闭", async (t) => {
  await t.test("乱序等价", () => {
    const root = createRepositoryFixture();
    const forward = prepareStaticAssetPlan(planInput(root, "production"));
    const reversed = prepareStaticAssetPlan(planInput(
      root,
      "production",
      registryDocument([
        {sourcePath: "robots.txt", role: "operational"},
        {sourcePath: "assets/brand/logo.svg", role: "brand"},
      ]),
    ));
    try {
      assert.deepEqual(reversed.manifest, forward.manifest);
    } finally {
      forward.dispose();
      reversed.dispose();
      rmSync(root, {recursive: true, force: true});
    }
  });

  await t.test("未知封套字段", () => {
    const root = createRepositoryFixture();
    const valid = registryDocument();
    const registry: RegistryDocumentInput = {
      sourcePath: valid.sourcePath,
      value: deepFreeze({
        ...(valid.value as Record<string, unknown>),
        unexpected: true,
      }),
    };
    try {
      assert.throws(
        () => prepareStaticAssetPlan(planInput(root, "production", registry)),
        hasStaticAssetCode("STATIC_ASSET_PUBLIC_REGISTRY_SCHEMA"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  await t.test("重复登记", () => {
    const root = createRepositoryFixture();
    try {
      assert.throws(
        () => prepareStaticAssetPlan(planInput(
          root,
          "production",
          registryDocument([
            {sourcePath: "assets/brand/logo.svg", role: "brand"},
            {sourcePath: "assets/brand/logo.svg", role: "brand"},
            {sourcePath: "robots.txt", role: "operational"},
          ]),
        )),
        hasStaticAssetCode("STATIC_ASSET_PUBLIC_DUPLICATE"),
      );
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});

test("I-12 production 素材泄漏检查正常路径通过", () => {
  const repositoryRoot = createRepositoryFixture();
  const materialized = materializedProduction(repositoryRoot);
  const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-production-build-"));
  chmodSync(buildRoot, 0o700);
  try {
    copyTreeBytes(materialized.staticRoot, buildRoot);
    writeSsrHtml(buildRoot, publicPreviewUrls(materialized.plan));
    assert.doesNotThrow(() => materialized.plan.assertProductionBuild(buildRoot));
  } finally {
    rmSync(repositoryRoot, {recursive: true, force: true});
    rmSync(materialized.contextRoot, {recursive: true, force: true});
    rmSync(buildRoot, {recursive: true, force: true});
  }
});

test("I-12 同名未发布素材的相同 path/content token 稳定去重", () => {
  const repositoryRoot = createRepositoryFixture();
  const sharedBytes = privateInlineAssetBytes();
  const unpublishedAssets = Array.from({length: 24}, (_, index) => ({
    sourcePath: `site-content/writing/duplicate-${String(index).padStart(2, "0")}/assets/shared-image.png`,
    publicPath: "/assets/images/shared-image-",
    bytes: sharedBytes,
  }));
  const materialized = materializedProduction(repositoryRoot, {
    ...planInput(repositoryRoot, "production"),
    unpublishedAssets,
  });
  const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-production-build-"));
  chmodSync(buildRoot, 0o700);
  try {
    const excludedContent = materialized.plan.manifest.excludedFiles.filter((file) => (
      file.kind === "content-asset"
    ));
    assert.equal(excludedContent.length, unpublishedAssets.length);
    assert.ok(excludedContent.every((file) => (
      file.kind === "content-asset"
      && file.publicUrl === "/assets/images/shared-image-"
    )));
    copyTreeBytes(materialized.staticRoot, buildRoot);
    writeSsrHtml(buildRoot, publicPreviewUrls(materialized.plan));
    assert.doesNotThrow(() => materialized.plan.assertProductionBuild(buildRoot));
  } finally {
    materialized.plan.dispose();
    rmSync(repositoryRoot, {recursive: true, force: true});
    rmSync(materialized.contextRoot, {recursive: true, force: true});
    rmSync(buildRoot, {recursive: true, force: true});
  }
});

test("I-12 内容寻址 URL 未知时不以同 basename 前缀误报公开资源", () => {
  const repositoryRoot = createRepositoryFixture();
  const materialized = materializedProduction(repositoryRoot, {
    ...planInput(repositoryRoot, "production"),
    unpublishedAssets: [{
      sourcePath: "site-content/writing/private/assets/shared-image.png",
      publicPath: null,
      bytes: Uint8Array.from([0x10, 0x20, 0x30, 0x40]),
    }],
  });
  const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-production-build-"));
  chmodSync(buildRoot, 0o700);
  try {
    copyTreeBytes(materialized.staticRoot, buildRoot);
    writeSsrHtml(buildRoot, publicPreviewUrls(materialized.plan));
    writeFixture(
      buildRoot,
      "assets/images/shared-image-public-content-hash.png",
      Uint8Array.from([0x50, 0x60, 0x70, 0x80]),
    );
    assert.equal(
      materialized.plan.manifest.excludedFiles.find((file) => (
        file.kind === "content-asset"
      ))?.publicUrl,
      null,
    );
    assert.doesNotThrow(() => materialized.plan.assertProductionBuild(buildRoot));
  } finally {
    materialized.plan.dispose();
    rmSync(repositoryRoot, {recursive: true, force: true});
    rmSync(materialized.contextRoot, {recursive: true, force: true});
    rmSync(buildRoot, {recursive: true, force: true});
  }
});

test("I-12 内容寻址 URL 未知时仍拒绝未发布素材源码路径泄漏", () => {
  const repositoryRoot = createRepositoryFixture();
  const sourcePath = "site-content/writing/private/assets/shared-image.png";
  const materialized = materializedProduction(repositoryRoot, {
    ...planInput(repositoryRoot, "production"),
    unpublishedAssets: [{
      sourcePath,
      publicPath: null,
      bytes: Uint8Array.from([0x10, 0x20, 0x30, 0x40]),
    }],
  });
  const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-production-build-"));
  chmodSync(buildRoot, 0o700);
  try {
    copyTreeBytes(materialized.staticRoot, buildRoot);
    writeSsrHtml(buildRoot, publicPreviewUrls(materialized.plan));
    writeFixture(buildRoot, "assets/source-map.js", `export const source=${JSON.stringify(sourcePath)};\n`);
    assert.throws(
      () => materialized.plan.assertProductionBuild(buildRoot),
      hasStaticAssetCode("STATIC_ASSET_UNPUBLISHED_PATH_LEAK"),
    );
  } finally {
    materialized.plan.dispose();
    rmSync(repositoryRoot, {recursive: true, force: true});
    rmSync(materialized.contextRoot, {recursive: true, force: true});
    rmSync(buildRoot, {recursive: true, force: true});
  }
});

test("I-12 仅浏览器有效的 img 候选构成 SSR 图片引用", async (t) => {
  const runHtml = (html: (urls: readonly string[]) => string, shouldPass: boolean): void => {
    const repositoryRoot = createRepositoryFixture();
    const materialized = materializedProduction(repositoryRoot);
    const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-production-build-"));
    chmodSync(buildRoot, 0o700);
    try {
      copyTreeBytes(materialized.staticRoot, buildRoot);
      writeFixture(buildRoot, "index.html", html(publicPreviewUrls(materialized.plan)));
      if (shouldPass) {
        assert.doesNotThrow(() => materialized.plan.assertProductionBuild(buildRoot));
      } else {
        assert.throws(
          () => materialized.plan.assertProductionBuild(buildRoot),
          hasStaticAssetCode("STATIC_ASSET_SSR_REFERENCE"),
        );
      }
    } finally {
      rmSync(repositoryRoot, {recursive: true, force: true});
      rmSync(materialized.contextRoot, {recursive: true, force: true});
      rmSync(buildRoot, {recursive: true, force: true});
    }
  };

  await t.test("picture source 不能替代必需的 img fallback", () => runHtml(
    (urls) => `<picture>${urls.map((url) => `<source srcset="${url} 1x, ${url} 2x">`).join("")}</picture>`,
    false,
  ));
  await t.test("合法 img srcset", () => runHtml(
    (urls) => urls.map((url) => `<img srcset="${url} 400w">`).join(""),
    true,
  ));
  await t.test("data 属性、自定义标签与惰性元素", () => runHtml(
    (urls) => urls.map((url) => [
      `<img data-src="${url}">`,
      `<source data-srcset="${url} 1x">`,
      `<img-data src="${url}"></img-data>`,
      `<img src="/not-the-preview.webp" src="${url}">`,
      `<template><img src="${url}"></template>`,
      `<script type="application/json">{"src":"${url}"}</script>`,
      `<script>const sample = '</scripture><img src="${url}">';</script>`,
      `<noscript><img src="${url}"></noscript>`,
      `<textarea><img src="${url}"></textarea>`,
      `<title><img src="${url}"></title>`,
    ].join("")).join(""),
    false,
  ));
  await t.test("select/option insertion mode 丢弃图片 token", () => runHtml(
    (urls) => `<select>${urls.map((url) => [
      `<option><img src="${url}"></option>`,
      `<optgroup><source srcset="${url} 1x"></optgroup>`,
      `</body><img src="${url}">`,
    ].join("")).join("")}</select>`,
    false,
  ));
  await t.test("frameset 丢弃图片 token", () => runHtml(
    (urls) => `<frameset>${urls.map((url) => `<img src="${url}">`).join("")}</frameset>`,
    false,
  ));
  await t.test("foreign、video/audio 与脱离直接 picture 上下文的 source 不构成图片引用", () => runHtml(
    (urls) => urls.map((url) => [
      `<svg><source srcset="${url} 1x"></source></svg>`,
      `<math><source srcset="${url} 1x"></source></math>`,
      `<source srcset="${url} 1x">`,
      `<picture><span><source srcset="${url} 1x"></span></picture>`,
      `<video><source srcset="${url} 1x"></video>`,
      `<audio><source srcset="${url} 1x"></audio>`,
    ].join("")).join(""),
    false,
  ));
  await t.test("picture source 的 src 属性不是图片候选", () => runHtml(
    (urls) => `<picture>${urls.map((url) => `<source src="${url}">`).join("")}</picture>`,
    false,
  ));
  await t.test("URL 内逗号及非法或重复 srcset 描述符不能伪造图片候选", () => runHtml(
    (urls) => urls.map((url) => [
      `<img srcset="${url},garbage 1x">`,
      `<img srcset="${url} 0w, ${url} 0x, ${url} unknown, ${url} 1x 2x">`,
      `<picture><source srcset="${url} 0w, ${url} 0x, ${url} unknown, ${url} 1x 2x"></picture>`,
    ].join("")).join(""),
    false,
  ));
});

test("I-12 production checker 对集合、字节、SSR、未发布 path/hash 与 preview mode 逐项失败", async (t) => {
  const runMutation = (
    mutate: (buildRoot: string, plan: StaticAssetPlan) => void,
    expectedCode: string,
  ): void => {
    const repositoryRoot = createRepositoryFixture();
    const materialized = materializedProduction(repositoryRoot);
    const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-production-build-"));
    chmodSync(buildRoot, 0o700);
    try {
      copyTreeBytes(materialized.staticRoot, buildRoot);
      writeSsrHtml(buildRoot, publicPreviewUrls(materialized.plan));
      mutate(buildRoot, materialized.plan);
      assert.throws(
        () => materialized.plan.assertProductionBuild(buildRoot),
        hasStaticAssetCode(expectedCode),
      );
    } finally {
      rmSync(repositoryRoot, {recursive: true, force: true});
      rmSync(materialized.contextRoot, {recursive: true, force: true});
      rmSync(buildRoot, {recursive: true, force: true});
    }
  };

  await t.test("项目文件缺失", () => runMutation((buildRoot) => {
    unlinkSync(resolve(
      buildRoot,
      "assets/projects/published-project/published-project.webp",
    ));
  }, "STATIC_ASSET_BUILD_WHITELIST"));

  await t.test("项目文件多余", () => runMutation((buildRoot) => {
    writeFixture(buildRoot, "assets/projects/extra/extra.webp", staticVp8l(0x77));
  }, "STATIC_ASSET_BUILD_PROJECT_SET"));

  await t.test("项目字节变化", () => runMutation((buildRoot) => {
    writeFileSync(
      resolve(buildRoot, "assets/projects/published-project/published-project.webp"),
      staticVp8l(0x99),
    );
  }, "STATIC_ASSET_BUILD_WHITELIST"));

  await t.test("build 符号链接", () => runMutation((buildRoot) => {
    symlinkSync(resolve(buildRoot, "robots.txt"), resolve(buildRoot, "linked-robots.txt"));
  }, "STATIC_ASSET_BUILD_FILE_TYPE"));

  await t.test("build 硬链接", () => runMutation((buildRoot) => {
    linkSync(resolve(buildRoot, "robots.txt"), resolve(buildRoot, "linked-robots.txt"));
  }, "STATIC_ASSET_BUILD_HARDLINK"));

  await t.test("build 大小写冲突", () => runMutation((buildRoot) => {
    writeFixture(buildRoot, "assets/case.txt", "lower\n");
    writeFixture(buildRoot, "assets/CASE.txt", "upper\n");
  }, "STATIC_ASSET_BUILD_CASE_CONFLICT"));

  await t.test("图片只出现在 HTML 注释", () => runMutation((buildRoot, plan) => {
    writeFixture(
      buildRoot,
      "index.html",
      publicPreviewUrls(plan).map((url) => `<!-- <img src="${url}"> -->`).join(""),
    );
  }, "STATIC_ASSET_SSR_REFERENCE"));

  await t.test("未发布路径跨 chunk 出现在任意二进制文件", () => runMutation((buildRoot) => {
    const prefix = Buffer.alloc(65_530, 0x61);
    writeFixture(
      buildRoot,
      "assets/leak.bin",
      Buffer.concat([prefix, Buffer.from(DRAFT_ARTICLE_URL, "utf8")]),
    );
  }, "STATIC_ASSET_UNPUBLISHED_PATH_LEAK"));

  await t.test("未发布原始字节跨 chunk 嵌入更大制品", () => runMutation((buildRoot) => {
    writeFixture(
      buildRoot,
      "assets/raw-content-leak.bin",
      Buffer.concat([
        Buffer.alloc(65_534, 0x61),
        Buffer.from(DRAFT_ARTICLE_BYTES),
        Buffer.from("tail", "ascii"),
      ]),
    );
  }, "STATIC_ASSET_UNPUBLISHED_BYTE_LEAK"));

  await t.test("小型 planned 项目素材的标准 Base64 跨 chunk 泄漏", () => {
    const repositoryRoot = createRepositoryFixture();
    const bytes = privateInlineAssetBytes();
    const materialized = materializedProduction(repositoryRoot, {
      ...planInput(repositoryRoot, "production"),
      unpublishedAssets: [{
        sourcePath: "site-content/projects/planned-project/assets/private-state.png",
        publicPath: "/projects/planned-project/assets/private-state.png",
        bytes,
      }],
    });
    const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-production-build-"));
    chmodSync(buildRoot, 0o700);
    try {
      copyTreeBytes(materialized.staticRoot, buildRoot);
      writeSsrHtml(buildRoot, publicPreviewUrls(materialized.plan));
      const dataUrlHeader = Buffer.from("data:image/png;base64,", "ascii");
      const base64 = Buffer.from(Buffer.from(bytes).toString("base64"), "ascii");
      const base64Start = 65_530;
      writeFixture(
        buildRoot,
        "assets/inline-data-url.js",
        Buffer.concat([
          Buffer.alloc(base64Start - dataUrlHeader.byteLength, 0x61),
          dataUrlHeader,
          base64,
        ]),
      );
      assert.throws(
        () => materialized.plan.assertProductionBuild(buildRoot),
        hasStaticAssetCode("STATIC_ASSET_UNPUBLISHED_BYTE_LEAK"),
      );
    } finally {
      materialized.plan.dispose();
      rmSync(repositoryRoot, {recursive: true, force: true});
      rmSync(materialized.contextRoot, {recursive: true, force: true});
      rmSync(buildRoot, {recursive: true, force: true});
    }
  });

  await t.test("超过 token 上限的未发布素材仍拒绝 Base64 内联", () => {
    const repositoryRoot = createRepositoryFixture();
    const bytes = Uint8Array.from(
      {length: 20 * 1024},
      (_, index) => (index * 31 + 17) % 251,
    );
    const materialized = materializedProduction(repositoryRoot, {
      ...planInput(repositoryRoot, "production"),
      unpublishedAssets: [{
        sourcePath: "site-content/writing/large-draft/assets/private-inline.bin",
        publicPath: null,
        bytes,
      }],
    });
    const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-production-build-"));
    chmodSync(buildRoot, 0o700);
    try {
      copyTreeBytes(materialized.staticRoot, buildRoot);
      writeSsrHtml(buildRoot, publicPreviewUrls(materialized.plan));
      writeFixture(
        buildRoot,
        "assets/large-inline.js",
        `export const payload="${Buffer.from(bytes).toString("base64")}";\n`,
      );
      assert.throws(
        () => materialized.plan.assertProductionBuild(buildRoot),
        hasStaticAssetCode("STATIC_ASSET_UNPUBLISHED_BYTE_LEAK"),
      );
    } finally {
      materialized.plan.dispose();
      rmSync(repositoryRoot, {recursive: true, force: true});
      rmSync(materialized.contextRoot, {recursive: true, force: true});
      rmSync(buildRoot, {recursive: true, force: true});
    }
  });

  await t.test("超过 token 上限的未发布素材仍拒绝原始字节窗口", () => {
    const repositoryRoot = createRepositoryFixture();
    const bytes = Uint8Array.from(
      {length: 20 * 1024},
      (_, index) => (index * 17 + 29) % 251,
    );
    const materialized = materializedProduction(repositoryRoot, {
      ...planInput(repositoryRoot, "production"),
      unpublishedAssets: [{
        sourcePath: "site-content/writing/large-draft/assets/private-window.bin",
        publicPath: null,
        bytes,
      }],
    });
    const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-production-build-"));
    chmodSync(buildRoot, 0o700);
    try {
      copyTreeBytes(materialized.staticRoot, buildRoot);
      writeSsrHtml(buildRoot, publicPreviewUrls(materialized.plan));
      writeFixture(
        buildRoot,
        "assets/raw-window.bin",
        Buffer.concat([
          Buffer.from("carrier-prefix", "ascii"),
          Buffer.from(bytes.subarray(0, 16 * 1024)),
          Buffer.from("carrier-suffix", "ascii"),
        ]),
      );
      assert.throws(
        () => materialized.plan.assertProductionBuild(buildRoot),
        hasStaticAssetCode("STATIC_ASSET_UNPUBLISHED_BYTE_LEAK"),
      );
    } finally {
      materialized.plan.dispose();
      rmSync(repositoryRoot, {recursive: true, force: true});
      rmSync(materialized.contextRoot, {recursive: true, force: true});
      rmSync(buildRoot, {recursive: true, force: true});
    }
  });

  await t.test("未发布正文素材改名同字节", () => runMutation((buildRoot) => {
    writeFixture(buildRoot, "assets/renamed.bin", DRAFT_ARTICLE_BYTES);
  }, "STATIC_ASSET_UNPUBLISHED_BYTE_LEAK"));

  await t.test("10 MiB 未发布素材由整文件摘要与窗口 token 共同兜底", () => {
    const repositoryRoot = createRepositoryFixture();
    const bytes = new Uint8Array(10 * 1024 * 1024);
    bytes.fill(0x5a);
    const materialized = materializedProduction(repositoryRoot, {
      ...planInput(repositoryRoot, "production"),
      unpublishedAssets: [{
        sourcePath: "site-content/writing/large-draft/assets/private-archive.bin",
        publicPath: "/writing/large-draft/assets/private-archive.bin",
        bytes,
      }],
    });
    const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-production-build-"));
    chmodSync(buildRoot, 0o700);
    try {
      copyTreeBytes(materialized.staticRoot, buildRoot);
      writeSsrHtml(buildRoot, publicPreviewUrls(materialized.plan));
      writeFixture(buildRoot, "assets/renamed-large.bin", bytes);
      assert.throws(
        () => materialized.plan.assertProductionBuild(buildRoot),
        hasStaticAssetCode("STATIC_ASSET_UNPUBLISHED_BYTE_LEAK"),
      );
    } finally {
      materialized.plan.dispose();
      rmSync(repositoryRoot, {recursive: true, force: true});
      rmSync(materialized.contextRoot, {recursive: true, force: true});
      rmSync(buildRoot, {recursive: true, force: true});
    }
  });

  await t.test("preview 计划不能进入 production 判定", () => {
    const repositoryRoot = createRepositoryFixture();
    const context = createBuildContext("preview");
    const plan = prepareStaticAssetPlan(planInput(repositoryRoot, "preview"));
    try {
      plan.materialize(context.context);
      assert.throws(
        () => plan.assertProductionBuild(context.context.staticDirectory),
        hasStaticAssetCode("STATIC_ASSET_PRODUCTION_MODE"),
      );
    } finally {
      rmSync(repositoryRoot, {recursive: true, force: true});
      rmSync(context.root, {recursive: true, force: true});
    }
  });
});

test("I-12 等价空 source fixture 与 planned catalog 形成空计划", () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "axial-muse-static-assets-empty-"));
  chmodSync(repositoryRoot, 0o700);
  const context = createBuildContext("production");
  const emptyProject = project("empty-planned", "planned", 1);
  const {previewImage: _previewImage, ...projectWithoutPreview} = emptyProject;
  const catalog = createCatalog([projectWithoutPreview]);
  try {
    const plan = prepareStaticAssetPlan({
      mode: "production",
      repositoryRoot,
      catalog,
      staticPublicRegistry: registryDocument([]),
    });
    assert.deepEqual(plan.manifest, {
      mode: "production",
      files: [],
      excludedFiles: [],
    });
    plan.materialize(context.context);
    assert.deepEqual(readdirSync(context.context.staticDirectory), []);
  } finally {
    rmSync(repositoryRoot, {recursive: true, force: true});
    rmSync(context.root, {recursive: true, force: true});
  }
});

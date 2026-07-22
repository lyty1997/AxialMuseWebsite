import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  prepareStaticAssetPlan,
  StaticAssetError,
} from "../../src/build/static-assets/index.js";
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

function writeSsrHtml(buildRoot: string, urls: readonly string[]): void {
  writeFixture(
    buildRoot,
    "index.html",
    `<!doctype html><html><body>${urls.map((url) => `<img src="${url}" alt="fixture">`).join("")}</body></html>`,
  );
}

function materializedProduction(root: string): Readonly<{
  plan: StaticAssetPlan;
  contextRoot: string;
  staticRoot: string;
}> {
  const plan = prepareStaticAssetPlan(planInput(root, "production"));
  const buildContext = createBuildContext("production");
  plan.materialize(buildContext.context);
  return {
    plan,
    contextRoot: buildContext.root,
    staticRoot: buildContext.context.staticDirectory,
  };
}

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

  await t.test("未发布正文素材改名同字节", () => runMutation((buildRoot) => {
    writeFixture(buildRoot, "assets/renamed.bin", DRAFT_ARTICLE_BYTES);
  }, "STATIC_ASSET_UNPUBLISHED_BYTE_LEAK"));

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

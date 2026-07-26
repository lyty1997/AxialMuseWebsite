import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";

const REAL_STATIC_VP8L_BASE64 = "UklGRmYAAABXRUJQVlA4TFkAAAAvP8b5AAdQkEIUpv8BAEX6/58i+p/63//+97///e9///vf//73v//973//+9///ve///3vf//73//+97///e9///vf//73v//973//+9///ve///3vf/+7BQA=";
const PROJECT_EMPTY_STATE = "当前还没有完成公开审核的项目。项目资料通过事实、隐私和视觉证据检查后会在这里出现。";
const WRITING_EMPTY_STATE = "技术分享正在从项目记录中整理。首批内容发布后会在这里提供可核验的原始资料与实现细节。";
const ROOT_FILES = Object.freeze([
  ".npmrc",
  ".nvmrc",
  "docusaurus.config.ts",
  "package-lock.json",
  "package.json",
  "sidebars.ts",
  "tsconfig.json",
]);
const ROOT_DIRECTORIES = Object.freeze([
  "src",
  "scripts/build",
  "scripts/content",
  "scripts/quality/lib",
]);
const ARTICLE_IDS = Object.freeze({
  archived: "018f0000-0000-7000-8000-000000000002",
  published: "018f0000-0000-7000-8000-000000000001",
});

function assertOrdinaryDirectory(path: string, label: string): string {
  const metadata = lstatSync(path);
  const canonical = realpathSync(path);
  assert.equal(metadata.isDirectory(), true, `${label} 必须是普通目录`);
  assert.equal(metadata.isSymbolicLink(), false, `${label} 不得是符号链接`);
  assert.equal(canonical, path, `${label} 必须是规范路径`);
  return canonical;
}

function copyOrdinaryTree(source: string, target: string): void {
  const metadata = lstatSync(source);
  assert.equal(metadata.isSymbolicLink(), false, "fixture copy 源不得含符号链接");
  if (metadata.isFile()) {
    mkdirSync(dirname(target), {recursive: true, mode: 0o700});
    copyFileSync(source, target);
    chmodSync(target, 0o600);
    return;
  }
  assert.equal(metadata.isDirectory(), true, "fixture copy 源只接受普通文件或目录");
  mkdirSync(target, {recursive: true, mode: 0o700});
  chmodSync(target, 0o700);
  for (const entry of readdirSync(source, {withFileTypes: true})) {
    assert.equal(entry.isSymbolicLink(), false, "fixture copy 源不得含符号链接");
    assert.equal(
      entry.isFile() || entry.isDirectory(),
      true,
      "fixture copy 源不得含特殊文件",
    );
    copyOrdinaryTree(resolve(source, entry.name), resolve(target, entry.name));
  }
}

function writeText(root: string, sourcePath: string, value: string | Uint8Array): void {
  const target = resolve(root, sourcePath);
  mkdirSync(dirname(target), {recursive: true, mode: 0o700});
  writeFileSync(target, value, {mode: 0o600});
  chmodSync(target, 0o600);
}

function writeJson(root: string, sourcePath: string, value: unknown): void {
  writeText(root, sourcePath, `${JSON.stringify(value, null, 2)}\n`);
}

function articleSource(frontMatter: Readonly<Record<string, unknown>>, body: string): string {
  return `---
${JSON.stringify(frontMatter)}
---
${body}`;
}

function materializePublicContentFixture(root: string): Uint8Array {
  writeJson(root, "docs/contracts/projects.json", {
    version: "0.3.0",
    kind: "axial_muse_projects",
    status: "active",
    owner: "AxialMuseWebsite",
    lifecycleStatusValues: ["active", "paused", "completed", "archived"],
    publicationStatusValues: ["draft", "planned", "published", "archived"],
    showcaseModes: ["repository", "repository-and-video"],
    projects: [{
      id: "archived-project",
      title: "Archived Fixture Project",
      slug: "archived-fixture-project",
      navigationOrder: 10,
      summary: "A traceable archived project rendered by the real presentation pipeline.",
      status: "completed",
      publicationStatus: "archived",
      startedAt: "2026-01",
      updatedAt: "2026-07-20",
      repositoryUrl: "https://github.com/lyty1997/AxialMuseWebsite",
      productionBranch: "main",
      showcaseMode: "repository",
      writingModules: [{
        id: "architecture-module",
        displayName: "架构模块",
        navigationOrder: 10,
        status: "active",
      }],
      previewImage: {
        sourcePath: "projects/archived-project/overview.webp",
        width: 1600,
        height: 1000,
        alt: "Archived fixture project interface with verified production evidence",
      },
      source: ["docs/projects/archived-project.md"],
    }],
  });
  writeJson(root, "docs/contracts/authors.json", {
    version: "0.1.0",
    kind: "axial_muse_authors",
    status: "active",
    owner: "AxialMuseWebsite",
    authors: {
      "fixture-author": {
        displayName: "Fixture 作者",
        links: {
          github: "https://github.com/lyty1997",
        },
      },
    },
  });
  writeJson(root, "docs/contracts/topics.json", {
    version: "0.1.0",
    kind: "axial_muse_topics",
    status: "active",
    owner: "AxialMuseWebsite",
    topics: {
      architecture: {
        displayName: "架构",
        navigationOrder: 10,
        status: "active",
      },
    },
  });
  writeJson(root, "docs/contracts/project-experiences.json", {
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
  });
  writeJson(root, "docs/contracts/static-public-assets.json", {
    version: "0.1.0",
    kind: "axial_muse_static_public_assets",
    status: "active",
    owner: "AxialMuseWebsite",
    roleValues: ["brand", "operational"],
    assets: [],
  });

  writeText(
    root,
    "site-content/projects/archived-project/index.md",
    "## Fixture 项目正文\n\n真实 Docusaurus 项目详情正文指纹：PUBLIC-PROJECT-BODY-27。\n",
  );
  writeText(
    root,
    "site-content/writing/published-article/index.md",
    articleSource({
      articleId: ARTICLE_IDS.published,
      title: "Published Fixture Article",
      slug: "/writing/published-fixture-article",
      summary: "A traceable general article rendered by the real presentation pipeline.",
      publicationStatus: "published",
      authors: ["fixture-author"],
      publishedAt: "2026-07-10",
      updatedAt: "2026-07-20",
      classification: {topics: ["architecture"]},
      seo: {
        description: "以真实 Docusaurus 构建证明通用文章列表、详情和 SEO 投影保持一致。",
        socialDescription: "真实公开文章 fixture 覆盖首页、技术分享目录、详情页和主题包装层。",
      },
    }, "## Fixture 通用文章正文\n\n真实文章正文指纹：PUBLIC-ARTICLE-BODY-27。\n"),
  );
  writeText(
    root,
    "site-content/writing/archived-article/index.md",
    articleSource({
      articleId: ARTICLE_IDS.archived,
      title: "Archived Fixture Article",
      slug: "/writing/archived-fixture-article",
      summary: "A traceable archived article rendered by the real presentation pipeline.",
      publicationStatus: "archived",
      authors: ["fixture-author"],
      publishedAt: "2026-07-11",
      updatedAt: "2026-07-19",
      classification: {
        project: "archived-project",
        module: "architecture-module",
        topics: ["architecture"],
      },
      seo: {
        description: "以真实 Docusaurus 构建证明归档文章的列表、详情与 SEO 投影一致。",
        socialDescription: "真实归档文章 fixture 覆盖项目分组、模块分组、详情元数据和归档标记。",
      },
    }, "## Fixture 归档文章正文\n\n真实归档正文指纹：ARCHIVED-ARTICLE-BODY-27。\n"),
  );

  const previewBytes = Uint8Array.from(
    Buffer.from(REAL_STATIC_VP8L_BASE64, "base64"),
  );
  assert.equal(previewBytes.byteLength, 110);
  writeText(
    root,
    "site-assets/projects/archived-project/overview.webp",
    previewBytes,
  );
  assert.deepEqual(
    readFileSync(resolve(root, "site-assets/projects/archived-project/overview.webp")),
    Buffer.from(previewBytes),
  );
  return previewBytes;
}

function assertContainsAll(value: string, expected: readonly string[]): void {
  for (const token of expected) assert.ok(value.includes(token), `缺少真实投影：${token}`);
}

function articleElementCount(value: string): number {
  return [...value.matchAll(/<article(?=[\t\n\f\r />])/giu)].length;
}

function sanitizedBuildDiagnostic(
  value: string | Buffer | null | undefined,
  repositoryRoot: string,
  temporaryRoot: string,
): string {
  return String(value ?? "")
    .replaceAll(repositoryRoot, "<repository>")
    .replaceAll(temporaryRoot, "<fixture>")
    .slice(-8_000);
}

test("I-14 真实 production build 渲染公开项目、文章与同路径主题包装层", () => {
  assert.equal(process.platform, "linux", "真实 Docusaurus fixture 只允许在 Linux 运行");
  const repositoryRoot = assertOrdinaryDirectory(realpathSync(process.cwd()), "仓库根");
  const temporaryParent = realpathSync(tmpdir());
  const temporaryRoot = mkdtempSync(
    join(temporaryParent, "axial-muse-public-presentation-"),
  );
  chmodSync(temporaryRoot, 0o700);
  assert.equal(dirname(temporaryRoot), temporaryParent);
  assert.ok(relative(temporaryParent, temporaryRoot).startsWith(
    "axial-muse-public-presentation-",
  ));
  const mirror = resolve(temporaryRoot, "mirror");
  mkdirSync(mirror, {mode: 0o700});
  const dependencyRoot = assertOrdinaryDirectory(
    resolve(repositoryRoot, "node_modules"),
    "冻结依赖根",
  );
  const dependencyLink = resolve(mirror, "node_modules");
  let dependencyLinkCreated = false;
  let operationError: unknown;
  let cleanupError: unknown;

  try {
    for (const sourcePath of ROOT_FILES) {
      copyOrdinaryTree(
        resolve(repositoryRoot, sourcePath),
        resolve(mirror, sourcePath),
      );
    }
    for (const sourcePath of ROOT_DIRECTORIES) {
      copyOrdinaryTree(
        resolve(repositoryRoot, sourcePath),
        resolve(mirror, sourcePath),
      );
    }
    const previewBytes = materializePublicContentFixture(mirror);
    symlinkSync(dependencyRoot, dependencyLink, "dir");
    dependencyLinkCreated = true;
    assert.equal(lstatSync(dependencyLink).isSymbolicLink(), true);
    assert.equal(realpathSync(dependencyLink), dependencyRoot);

    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => (
          entry[1] !== undefined && !entry[0].startsWith("AXIAL_MUSE_")
        ),
      ),
    );
    const result = spawnSync(
      process.execPath,
      [resolve(mirror, "scripts/build/build-site.mjs"), "--mode", "production"],
      {
        cwd: mirror,
        env: environment,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10 * 60 * 1000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.equal(
      result.status,
      0,
      [
        "真实公开内容 fixture production build 失败。",
        sanitizedBuildDiagnostic(result.stdout, repositoryRoot, temporaryRoot),
        sanitizedBuildDiagnostic(result.stderr, repositoryRoot, temporaryRoot),
      ].join("\n"),
    );
    assert.equal(result.signal, null);
    assert.equal(result.error, undefined);

    const buildRoot = resolve(mirror, "build");
    const home = readFileSync(resolve(buildRoot, "index.html"), "utf8");
    const projects = readFileSync(resolve(buildRoot, "projects/index.html"), "utf8");
    const projectDetail = readFileSync(
      resolve(buildRoot, "projects/archived-fixture-project/index.html"),
      "utf8",
    );
    const writing = readFileSync(resolve(buildRoot, "writing/index.html"), "utf8");
    const publishedArticle = readFileSync(
      resolve(buildRoot, "writing/published-fixture-article/index.html"),
      "utf8",
    );
    const archivedArticle = readFileSync(
      resolve(buildRoot, "writing/archived-fixture-article/index.html"),
      "utf8",
    );

    assert.equal(articleElementCount(home), 3);
    assert.equal(articleElementCount(projects), 1);
    assert.equal(articleElementCount(writing), 2);
    for (const listPage of [home, projects, writing]) {
      assert.equal(listPage.includes(PROJECT_EMPTY_STATE), false);
      assert.equal(listPage.includes(WRITING_EMPTY_STATE), false);
    }
    assertContainsAll(home, [
      "Archived Fixture Project",
      "Published Fixture Article",
      "Archived Fixture Article",
      "公开状态：已归档",
    ]);
    assertContainsAll(projects, [
      "Archived Fixture Project",
      "项目状态：",
      "已完成",
      "公开状态：已归档",
      "查看源码",
    ]);
    assertContainsAll(writing, [
      "通用技术",
      "Archived Fixture Project",
      "架构模块",
      "Published Fixture Article",
      "Archived Fixture Article",
      "已归档",
    ]);
    assertContainsAll(projectDetail, [
      "A traceable archived project rendered by the real presentation pipeline.",
      "项目状态",
      "已完成",
      "公开状态",
      "已归档",
      "查看源码",
      "PUBLIC-PROJECT-BODY-27",
      "https://www.axialmuse.com/projects/archived-fixture-project/",
      "https://www.axialmuse.com/assets/projects/archived-project/overview.webp",
    ]);
    assertContainsAll(publishedArticle, [
      "Published Fixture Article",
      "Fixture 作者",
      "架构",
      "2026-07-10",
      "2026-07-20",
      "PUBLIC-ARTICLE-BODY-27",
      "https://www.axialmuse.com/writing/published-fixture-article/",
    ]);
    assertContainsAll(archivedArticle, [
      "Archived Fixture Article",
      "Fixture 作者",
      "架构",
      "已归档",
      "ARCHIVED-ARTICLE-BODY-27",
      "https://www.axialmuse.com/writing/archived-fixture-article/",
    ]);
    assert.match(
      projectDetail,
      /aria-label=(?:"项目资料"|项目资料)(?=[\t\n\f\r >])/u,
    );
    for (const articleDetail of [publishedArticle, archivedArticle]) {
      assert.match(
        articleDetail,
        /aria-label=(?:"文章资料"|文章资料)(?=[\t\n\f\r >])/u,
      );
    }
    assert.match(
      projectDetail,
      /<meta(?=[^>]*\bproperty=(?:"og:type"|og:type)(?=[\t\n\f\r />]))(?=[^>]*\bcontent=(?:"website"|website)(?=[\t\n\f\r />]))[^>]*>/u,
    );
    assert.match(
      publishedArticle,
      /<meta(?=[^>]*\bproperty=(?:"og:type"|og:type)(?=[\t\n\f\r />]))(?=[^>]*\bcontent=(?:"article"|article)(?=[\t\n\f\r />]))[^>]*>/u,
    );
    assert.deepEqual(
      readFileSync(
        resolve(buildRoot, "assets/projects/archived-project/overview.webp"),
      ),
      Buffer.from(previewBytes),
    );
    const sitemap = readFileSync(resolve(buildRoot, "sitemap.xml"), "utf8");
    assertContainsAll(sitemap, [
      "https://www.axialmuse.com/",
      "https://www.axialmuse.com/projects/",
      "https://www.axialmuse.com/projects/archived-fixture-project/",
      "https://www.axialmuse.com/writing/",
      "https://www.axialmuse.com/writing/published-fixture-article/",
      "https://www.axialmuse.com/writing/archived-fixture-article/",
    ]);
  } catch (error) {
    operationError = error;
  } finally {
    if (dependencyLinkCreated) {
      try {
        const metadata = lstatSync(dependencyLink);
        if (!metadata.isSymbolicLink() || realpathSync(dependencyLink) !== dependencyRoot) {
          throw new Error("fixture node_modules 链接身份漂移，拒绝递归清理");
        }
        unlinkSync(dependencyLink);
        dependencyLinkCreated = false;
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError === undefined) {
      try {
        assert.equal(realpathSync(temporaryRoot), temporaryRoot);
        assert.equal(dirname(temporaryRoot), temporaryParent);
        rmSync(temporaryRoot, {recursive: true, force: false});
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  if (cleanupError !== undefined) {
    throw new Error("真实公开内容 fixture 私有临时目录清理失败", {
      cause: operationError === undefined
        ? cleanupError
        : new AggregateError([operationError, cleanupError]),
    });
  }
  if (operationError !== undefined) throw operationError;
});

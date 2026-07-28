import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath, pathToFileURL} from "node:url";
import {
  buildContentHistoryGitEnvironment,
  checkArticleDateHistoryCandidate,
  checkContentHistory,
  checkContentHistoryCandidate,
  ContentHistoryError,
} from "../../scripts/quality/lib/content-history.mjs";

const ARTICLE_A = "018f0000-0000-7000-8000-000000000001";
const ARTICLE_B = "018f0000-0000-7000-8000-000000000002";
const ARTICLE_C = "018f0000-0000-7000-8000-000000000003";
const CONTENT_HISTORY_CLI = fileURLToPath(new URL(
  "../../scripts/quality/check-content-history.mjs",
  import.meta.url,
));

function runGit(root, arguments_, {allowFailure = false} = {}) {
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
    },
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (
    !allowFailure
    && (
      result.error
      || result.status !== 0
      || (result.signal !== null && result.signal !== undefined)
    )
  ) {
    throw new Error(`fixture git command failed: git ${arguments_.join(" ")}`);
  }
  return result;
}

function runHistoryCli(root, arguments_ = []) {
  return spawnSync(process.execPath, [CONTENT_HISTORY_CLI, ...arguments_], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
}

function runHistoryCliWithoutFrozenParser(root) {
  const hookPath = join(root, "block-frozen-frontmatter-parser.mjs");
  writeFileSync(
    hookPath,
    [
      'import {registerHooks} from "node:module";',
      "registerHooks({",
      "  resolve(specifier, context, nextResolve) {",
      '    if (specifier === "@docusaurus/utils") {',
      '      throw new Error("blocked frozen parser");',
      "    }",
      "    return nextResolve(specifier, context);",
      "  },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(hookPath).href,
      CONTENT_HISTORY_CLI,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
}

function writeJson(root, sourcePath, value) {
  const path = join(root, ...sourcePath.split("/"));
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(root, sourcePath, value) {
  const path = join(root, ...sourcePath.split("/"));
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, value, "utf8");
}

function projectRecord(id, navigationOrder) {
  return {
    id,
    title: `Fixture ${id}`,
    slug: id,
    navigationOrder,
    summary: `A traceable project summary for ${id} with sufficient fixture evidence.`,
    status: "active",
    publicationStatus: "draft",
    startedAt: "2026-01",
    updatedAt: "2026-07-20",
    repositoryUrl: `https://example.com/${id}`,
    productionBranch: "main",
    showcaseMode: "repository",
    writingModules: [],
    source: [`docs/projects/${id}.md`],
  };
}

function projects(ids = []) {
  return {
    version: "0.3.0",
    kind: "axial_muse_projects",
    status: "active",
    owner: "AxialMuseWebsite",
    lifecycleStatusValues: ["active", "paused", "completed", "archived"],
    publicationStatusValues: ["draft", "planned", "published", "archived"],
    showcaseModes: ["repository", "repository-and-video"],
    projects: [...ids]
      .sort()
      .map((id, index) => projectRecord(id, (index + 1) * 10)),
  };
}

function writeProjectSources(root, projectIds) {
  const projectsRoot = join(root, "site-content", "projects");
  rmSync(projectsRoot, {recursive: true, force: true});
  mkdirSync(projectsRoot, {recursive: true});
  writeFileSync(
    join(projectsRoot, ".gitkeep"),
    "# Empty directories remain explicit in fixture history.\n",
    "utf8",
  );
  for (const projectId of projectIds) {
    writeText(
      root,
      `site-content/projects/${projectId}/index.md`,
      `## ${projectId}\n\n项目正文提供稳定且可复核的实现证据。\n`,
    );
  }
}

function writeRegistries(root, projectIds = []) {
  writeProjectSources(root, projectIds);
  writeJson(root, "docs/contracts/projects.json", projects(projectIds));
  writeJson(root, "docs/contracts/authors.json", {
    version: "0.1.0",
    kind: "axial_muse_authors",
    status: "active",
    owner: "AxialMuseWebsite",
    authors: {
      "example-author": {displayName: "示例作者"},
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
}

function articleText(
  articleId,
  sourceName,
  body = "可复核的 fixture 正文。",
) {
  return articleStateText(articleId, sourceName, {body});
}

function articleStateText(
  articleId,
  sourceName,
  {
    body = "可复核的 fixture 正文。",
    publicationStatus = "draft",
    publishedAt,
    updatedAt = publicationStatus === "draft" ? "2026-07-20" : publishedAt,
  } = {},
) {
  return [
    "---",
    `articleId: "${articleId}"`,
    `title: "Fixture ${sourceName}"`,
    `slug: "/writing/${sourceName}"`,
    `summary: "A traceable technical article for ${sourceName} with sufficient fixture evidence."`,
    `publicationStatus: "${publicationStatus}"`,
    ...(publishedAt === undefined
      ? []
      : [`publishedAt: "${publishedAt}"`]),
    ...(updatedAt === undefined
      ? []
      : [`updatedAt: "${updatedAt}"`]),
    "authors:",
    '  - "example-author"',
    "classification:",
    "  topics:",
    '    - "architecture"',
    "---",
    "",
    "## 技术问题",
    "",
    body,
    "",
  ].join("\n");
}

function writeArticle(root, sourceName, articleId, body, extension = "md") {
  const path = join(
    root,
    "site-content",
    "writing",
    sourceName,
    `index.${extension}`,
  );
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, articleText(articleId, sourceName, body), "utf8");
}

function writeArticleState(
  root,
  sourceName,
  articleId,
  options,
  extension = "md",
) {
  const path = join(
    root,
    "site-content",
    "writing",
    sourceName,
    `index.${extension}`,
  );
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(
    path,
    articleStateText(articleId, sourceName, options),
    "utf8",
  );
}

function writeMinimalArticle(root, sourceName, articleId) {
  writeText(
    root,
    `site-content/writing/${sourceName}/index.md`,
    `---\narticleId: "${articleId}"\n---\n\n最小历史身份 fixture。\n`,
  );
}

function commit(root, message) {
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "--quiet", "-m", message]);
  return runGit(root, ["rev-parse", "HEAD"]).stdout.trim();
}

function rewriteCommitGraphHeadAsRoot(root, head) {
  runGit(root, ["commit-graph", "write", "--reachable"]);
  const graphPath = resolve(
    root,
    runGit(
      root,
      ["rev-parse", "--git-path", "objects/info/commit-graph"],
    ).stdout.trim(),
  );
  const graph = readFileSync(graphPath);
  assert.equal(graph.subarray(0, 4).toString("ascii"), "CGPH");
  assert.equal(graph[4], 1);
  assert.equal(graph[5], 1);
  assert.equal(graph[7], 0);

  const chunks = new Map();
  for (let index = 0; index < graph[6]; index += 1) {
    const entry = 8 + (index * 12);
    const id = graph.subarray(entry, entry + 4).toString("ascii");
    const offset = Number(graph.readBigUInt64BE(entry + 4));
    assert.equal(Number.isSafeInteger(offset), true);
    chunks.set(id, offset);
  }
  const oidFanout = chunks.get("OIDF");
  const oidLookup = chunks.get("OIDL");
  const commitData = chunks.get("CDAT");
  assert.equal(typeof oidFanout, "number");
  assert.equal(typeof oidLookup, "number");
  assert.equal(typeof commitData, "number");

  const commitCount = graph.readUInt32BE(oidFanout + (255 * 4));
  let headIndex = -1;
  for (let index = 0; index < commitCount; index += 1) {
    if (
      graph.subarray(
        oidLookup + (index * 20),
        oidLookup + ((index + 1) * 20),
      ).toString("hex") === head
    ) {
      headIndex = index;
      break;
    }
  }
  assert.notEqual(headIndex, -1);

  const record = commitData + (headIndex * 36);
  graph.writeUInt32BE(0x70000000, record + 20);
  graph.writeUInt32BE(0x70000000, record + 24);
  graph.writeUInt32BE(
    (graph.readUInt32BE(record + 28) & 0x3) | 0x4,
    record + 28,
  );
  const trailer = createHash("sha1")
    .update(graph.subarray(0, graph.length - 20))
    .digest();
  trailer.copy(graph, graph.length - 20);
  chmodSync(graphPath, 0o600);
  writeFileSync(graphPath, graph);
}

function createFixture({article = null, projectIds = []} = {}) {
  const outer = mkdtempSync("/tmp/axial-muse-history-test-");
  const root = join(outer, "project");
  mkdirSync(root, {recursive: true});
  runGit(root, ["init", "--quiet", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "History Fixture"]);
  runGit(root, ["config", "user.email", "history@example.test"]);
  writeText(
    root,
    "site-content/writing/.gitkeep",
    "# Empty directories remain explicit in fixture history.\n",
  );
  writeRegistries(root, projectIds);
  if (article !== null) {
    writeArticle(root, article.sourceName, article.articleId, article.body);
  }
  commit(root, "baseline");
  return {outer, root};
}

function destroyFixture(fixture) {
  rmSync(fixture.outer, {recursive: true, force: true});
}

async function checkFixture(root) {
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    return await checkContentHistory();
  } finally {
    process.chdir(previousCwd);
  }
}

async function checkCandidateFixture(root, candidate) {
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    return await checkContentHistoryCandidate(candidate);
  } finally {
    process.chdir(previousCwd);
  }
}

async function checkDateCandidateFixture(root, candidate) {
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    return await checkArticleDateHistoryCandidate(candidate);
  } finally {
    process.chdir(previousCwd);
  }
}

async function expectHistoryError(root, code, sourcePath = null) {
  await assert.rejects(
    checkFixture(root),
    (error) => (
      error instanceof ContentHistoryError
      && error.code === code
      && (sourcePath === null || error.sourcePath === sourcePath)
    ),
  );
}

test("E-013 连续修改与保留 articleId 的原子 source-name 改名通过", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "original-name"},
    projectIds: ["alpha-project"],
  });
  try {
    writeArticle(
      fixture.root,
      "original-name",
      ARTICLE_A,
      "连续修改仍保留相同身份。",
    );
    commit(fixture.root, "edit article");
    renameSync(
      join(fixture.root, "site-content/writing/original-name"),
      join(fixture.root, "site-content/writing/renamed-article"),
    );
    writeArticle(
      fixture.root,
      "renamed-article",
      ARTICLE_A,
      "原子改名同步更新当前 slug。",
    );
    commit(fixture.root, "rename article");

    const result = await checkFixture(fixture.root);
    assert.equal(result.articleCount, 1);
    assert.equal(result.registryIdentityCount, 3);
    assert.equal(result.commitCount, 3);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 同一 source-name 不得改绑新的 articleId", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "stable-source"},
  });
  try {
    writeArticle(fixture.root, "stable-source", ARTICLE_B);
    commit(fixture.root, "rebind source");
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_SOURCE_REUSED",
      "site-content/writing/stable-source",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 articleId 删除后不得重新引入", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "first-source"},
  });
  try {
    rmSync(join(fixture.root, "site-content/writing/first-source"), {
      recursive: true,
      force: true,
    });
    commit(fixture.root, "remove article");
    writeArticle(fixture.root, "second-source", ARTICLE_A);
    commit(fixture.root, "reintroduce article");
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_ARTICLE_REINTRODUCED",
      "site-content/writing/second-source",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 稳定注册表 ID 删除后不得重新引入", async () => {
  const fixture = createFixture({projectIds: ["stable-project"]});
  try {
    writeRegistries(fixture.root, []);
    commit(fixture.root, "remove project");
    writeRegistries(fixture.root, ["stable-project"]);
    commit(fixture.root, "reintroduce project");
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_REGISTRY_REINTRODUCED",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 平行分支独立首次引入同一 articleId 时合并失败", async () => {
  const fixture = createFixture();
  try {
    const base = runGit(fixture.root, ["rev-parse", "HEAD"]).stdout.trim();
    runGit(fixture.root, ["checkout", "--quiet", "-b", "left", base]);
    writeArticle(fixture.root, "left-source", ARTICLE_A);
    commit(fixture.root, "left article");

    runGit(fixture.root, ["checkout", "--quiet", "-b", "right", base]);
    writeArticle(fixture.root, "right-source", ARTICLE_A);
    commit(fixture.root, "right article");

    runGit(fixture.root, ["checkout", "--quiet", "left"]);
    runGit(fixture.root, [
      "merge",
      "--quiet",
      "--no-ff",
      "-s",
      "ours",
      "right",
      "-m",
      "merge parallel article",
    ]);
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_ARTICLE_LINEAGE_CONFLICT",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 平行分支独立首次引入同一注册表 ID 时合并失败", async () => {
  const fixture = createFixture();
  try {
    const base = runGit(fixture.root, ["rev-parse", "HEAD"]).stdout.trim();
    runGit(fixture.root, ["checkout", "--quiet", "-b", "left", base]);
    writeRegistries(fixture.root, ["parallel-project"]);
    commit(fixture.root, "left project");

    runGit(fixture.root, ["checkout", "--quiet", "-b", "right", base]);
    writeRegistries(fixture.root, ["parallel-project"]);
    commit(fixture.root, "right project");

    runGit(fixture.root, ["checkout", "--quiet", "left"]);
    runGit(fixture.root, [
      "merge",
      "--quiet",
      "--no-ff",
      "-s",
      "ours",
      "right",
      "-m",
      "merge parallel project",
    ]);
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_REGISTRY_LINEAGE_CONFLICT",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 合并父历史对同一 source-name 的不同绑定失败", async () => {
  const fixture = createFixture();
  try {
    const base = runGit(fixture.root, ["rev-parse", "HEAD"]).stdout.trim();
    runGit(fixture.root, ["checkout", "--quiet", "-b", "left", base]);
    writeArticle(fixture.root, "shared-source", ARTICLE_A);
    commit(fixture.root, "left binding");

    runGit(fixture.root, ["checkout", "--quiet", "-b", "right", base]);
    writeArticle(fixture.root, "shared-source", ARTICLE_B);
    commit(fixture.root, "right binding");

    runGit(fixture.root, ["checkout", "--quiet", "left"]);
    runGit(fixture.root, [
      "merge",
      "--quiet",
      "--no-ff",
      "-s",
      "ours",
      "right",
      "-m",
      "merge conflicting source",
    ]);
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_SOURCE_LINEAGE_CONFLICT",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 一个父仍保留同 lineage 的普通 merge 通过", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "shared-lineage"},
  });
  try {
    const base = runGit(fixture.root, ["rev-parse", "HEAD"]).stdout.trim();
    runGit(fixture.root, ["checkout", "--quiet", "-b", "left", base]);
    writeArticle(
      fixture.root,
      "shared-lineage",
      ARTICLE_A,
      "左分支修改正文。",
    );
    commit(fixture.root, "left edit");

    runGit(fixture.root, ["checkout", "--quiet", "-b", "right", base]);
    writeFileSync(join(fixture.root, "right-evidence.txt"), "right\n", "utf8");
    commit(fixture.root, "right evidence");

    runGit(fixture.root, ["checkout", "--quiet", "left"]);
    runGit(fixture.root, [
      "merge",
      "--quiet",
      "--no-ff",
      "right",
      "-m",
      "normal merge",
    ]);
    const result = await checkFixture(fixture.root);
    assert.equal(result.articleCount, 1);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 同一快照中的重复 articleId 失败", async () => {
  const fixture = createFixture();
  try {
    writeArticle(fixture.root, "first-duplicate", ARTICLE_A);
    writeArticle(fixture.root, "second-duplicate", ARTICLE_A);
    commit(fixture.root, "duplicate article");
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_ARTICLE_DUPLICATE",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 工作区未提交候选同样受 source-name 保留映射约束", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "worktree-source"},
  });
  try {
    writeArticle(fixture.root, "worktree-source", ARTICLE_C);
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_SOURCE_REUSED",
      "site-content/writing/worktree-source",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 候选 API 只在内存叠加新身份且不修改工作区", async () => {
  const fixture = createFixture();
  try {
    const sourceName = "candidate-article";
    const target = join(
      fixture.root,
      "site-content",
      "writing",
      sourceName,
    );
    const before = runGit(
      fixture.root,
      ["status", "--porcelain=v1", "--untracked-files=all"],
    ).stdout;
    assert.equal(existsSync(target), false);
    const result = await checkCandidateFixture(fixture.root, {
      articleId: ARTICLE_A,
      sourceName,
    });
    assert.equal(result.articleCount, 1);
    assert.equal(existsSync(target), false);
    assert.equal(
      runGit(
        fixture.root,
        ["status", "--porcelain=v1", "--untracked-files=all"],
      ).stdout,
      before,
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 候选 API 拒绝历史 articleId 重引和 source-name 改绑", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "reserved-candidate"},
  });
  try {
    rmSync(
      join(fixture.root, "site-content", "writing", "reserved-candidate"),
      {recursive: true, force: true},
    );
    commit(fixture.root, "remove reserved candidate");
    await assert.rejects(
      checkCandidateFixture(fixture.root, {
        articleId: ARTICLE_A,
        sourceName: "replacement-candidate",
      }),
      (error) => (
        error instanceof ContentHistoryError
        && error.code === "CONTENT_HISTORY_ARTICLE_REINTRODUCED"
        && error.sourcePath
          === "site-content/writing/replacement-candidate"
      ),
    );
    await assert.rejects(
      checkCandidateFixture(fixture.root, {
        articleId: ARTICLE_B,
        sourceName: "reserved-candidate",
      }),
      (error) => (
        error instanceof ContentHistoryError
        && error.code === "CONTENT_HISTORY_SOURCE_REUSED"
        && error.sourcePath === "site-content/writing/reserved-candidate"
      ),
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 候选 API 将工作区删除视为新建而非同 lineage 改名", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "worktree-deleted"},
  });
  try {
    rmSync(
      join(fixture.root, "site-content", "writing", "worktree-deleted"),
      {recursive: true, force: true},
    );
    await assert.rejects(
      checkCandidateFixture(fixture.root, {
        articleId: ARTICLE_A,
        sourceName: "worktree-replacement",
      }),
      (error) => (
        error instanceof ContentHistoryError
        && error.code === "CONTENT_HISTORY_ARTICLE_REINTRODUCED"
        && error.sourcePath === "site-content/writing/worktree-replacement"
      ),
    );
    await assert.rejects(
      checkCandidateFixture(fixture.root, {
        articleId: ARTICLE_B,
        sourceName: "worktree-deleted",
      }),
      (error) => (
        error instanceof ContentHistoryError
        && error.code === "CONTENT_HISTORY_SOURCE_REUSED"
        && error.sourcePath === "site-content/writing/worktree-deleted"
      ),
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 候选 API 拒绝额外字段、访问器和无效身份", async () => {
  const extra = {
    articleId: ARTICLE_A,
    parser() {},
    sourceName: "candidate-extra-field",
  };
  await assert.rejects(
    checkContentHistoryCandidate(extra),
    (error) => (
      error instanceof ContentHistoryError
      && error.code === "CONTENT_HISTORY_CANDIDATE"
    ),
  );

  const accessor = {sourceName: "candidate-accessor"};
  Object.defineProperty(accessor, "articleId", {
    enumerable: true,
    get() {
      throw new Error("candidate accessor must not execute");
    },
  });
  await assert.rejects(
    checkContentHistoryCandidate(accessor),
    (error) => (
      error instanceof ContentHistoryError
      && error.code === "CONTENT_HISTORY_CANDIDATE"
    ),
  );

  const fixture = createFixture();
  try {
    await assert.rejects(
      checkCandidateFixture(fixture.root, {
        articleId: ARTICLE_A,
        sourceName: "Invalid Candidate",
      }),
      (error) => (
        error instanceof ContentHistoryError
        && error.code === "CONTENT_HISTORY_ARTICLE_PATH"
      ),
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 候选 API 在当前工作区已有错误时先失败", async () => {
  const fixture = createFixture();
  try {
    writeText(
      fixture.root,
      "site-content/writing/invalid-current/unexpected.txt",
      "invalid\n",
    );
    await assert.rejects(
      checkCandidateFixture(fixture.root, {
        articleId: ARTICLE_A,
        sourceName: "candidate-after-invalid-current",
      }),
      (error) => (
        error instanceof ContentHistoryError
        && error.code === "CONTENT_HISTORY_CURRENT_SCHEMA"
        && error.sourcePath === "site-content/writing/invalid-current"
      ),
    );
    assert.equal(
      existsSync(join(
        fixture.root,
        "site-content",
        "writing",
        "candidate-after-invalid-current",
      )),
      false,
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 publishedAt 建立后允许同值修订与 source-name 改名", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "dated-original"},
  });
  try {
    writeArticleState(
      fixture.root,
      "dated-original",
      ARTICLE_A,
      {
        publicationStatus: "published",
        publishedAt: "2026-07-20",
      },
    );
    commit(fixture.root, "publish dated article");
    renameSync(
      join(fixture.root, "site-content/writing/dated-original"),
      join(fixture.root, "site-content/writing/dated-renamed"),
    );
    writeArticleState(
      fixture.root,
      "dated-renamed",
      ARTICLE_A,
      {
        body: "改名后的修订正文。",
        publicationStatus: "published",
        publishedAt: "2026-07-20",
        updatedAt: "2026-07-21",
      },
    );
    commit(fixture.root, "revise and rename dated article");

    const result = await checkFixture(fixture.root);
    assert.equal(result.articleCount, 1);
    assert.equal(result.commitCount, 3);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 历史与工作区 MDX 存活文章不得修改或删除 publishedAt", async () => {
  const changed = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "changed-date"},
  });
  try {
    renameSync(
      join(changed.root, "site-content/writing/changed-date/index.md"),
      join(changed.root, "site-content/writing/changed-date/index.mdx"),
    );
    writeArticleState(changed.root, "changed-date", ARTICLE_A, {
      publicationStatus: "published",
      publishedAt: "2026-07-20",
    }, "mdx");
    commit(changed.root, "establish date before change");
    writeArticleState(changed.root, "changed-date", ARTICLE_A, {
      publicationStatus: "published",
      publishedAt: "2026-07-21",
    }, "mdx");
    commit(changed.root, "change first publication date");
    await expectHistoryError(
      changed.root,
      "CONTENT_HISTORY_DATE_CHANGED",
      "site-content/writing/changed-date/index.mdx",
    );
  } finally {
    destroyFixture(changed);
  }

  const removed = createFixture({
    article: {articleId: ARTICLE_B, sourceName: "removed-date"},
  });
  try {
    renameSync(
      join(removed.root, "site-content/writing/removed-date/index.md"),
      join(removed.root, "site-content/writing/removed-date/index.mdx"),
    );
    writeArticleState(removed.root, "removed-date", ARTICLE_B, {
      publicationStatus: "published",
      publishedAt: "2026-07-20",
    }, "mdx");
    commit(removed.root, "establish date before removal");
    writeArticle(
      removed.root,
      "removed-date",
      ARTICLE_B,
      "删除日期但保留文章。",
      "mdx",
    );
    await expectHistoryError(
      removed.root,
      "CONTENT_HISTORY_DATE_REMOVED",
      "site-content/writing/removed-date/index.mdx",
    );
  } finally {
    destroyFixture(removed);
  }
});

test("E-013 整篇文章删除不误报 publishedAt 删除", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "deleted-dated-article"},
  });
  try {
    writeArticleState(
      fixture.root,
      "deleted-dated-article",
      ARTICLE_A,
      {
        publicationStatus: "published",
        publishedAt: "2026-07-20",
      },
    );
    commit(fixture.root, "publish before whole deletion");
    rmSync(
      join(
        fixture.root,
        "site-content",
        "writing",
        "deleted-dated-article",
      ),
      {recursive: true, force: true},
    );
    commit(fixture.root, "delete whole dated article");

    const result = await checkFixture(fixture.root);
    assert.equal(result.articleCount, 0);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 历史快照拒绝非规范 publishedAt", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "invalid-date"},
  });
  try {
    writeArticleState(fixture.root, "invalid-date", ARTICLE_A, {
      publicationStatus: "published",
      publishedAt: "2026-02-30",
    });
    commit(fixture.root, "invalid historical date");
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_PUBLISHED_AT",
      "site-content/writing/invalid-date/index.md",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 merge 父历史中相同 publishedAt 通过", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "same-merge-date"},
  });
  try {
    const base = runGit(fixture.root, ["rev-parse", "HEAD"]).stdout.trim();
    runGit(fixture.root, ["checkout", "--quiet", "-b", "left", base]);
    writeArticleState(fixture.root, "same-merge-date", ARTICLE_A, {
      body: "左分支发布。",
      publicationStatus: "published",
      publishedAt: "2026-07-20",
    });
    commit(fixture.root, "left same publication date");

    runGit(fixture.root, ["checkout", "--quiet", "-b", "right", base]);
    writeArticleState(fixture.root, "same-merge-date", ARTICLE_A, {
      body: "右分支发布。",
      publicationStatus: "published",
      publishedAt: "2026-07-20",
    });
    commit(fixture.root, "right same publication date");

    runGit(fixture.root, ["checkout", "--quiet", "left"]);
    runGit(fixture.root, [
      "merge",
      "--quiet",
      "--no-ff",
      "-s",
      "ours",
      "right",
      "-m",
      "merge same publication date",
    ]);
    const result = await checkFixture(fixture.root);
    assert.equal(result.articleCount, 1);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 merge 一侧无日期时继承另一侧 publishedAt", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "inherited-merge-date"},
  });
  try {
    const base = runGit(fixture.root, ["rev-parse", "HEAD"]).stdout.trim();
    runGit(fixture.root, ["checkout", "--quiet", "-b", "left", base]);
    writeArticleState(fixture.root, "inherited-merge-date", ARTICLE_A, {
      publicationStatus: "published",
      publishedAt: "2026-07-20",
    });
    commit(fixture.root, "left establishes publication date");

    runGit(fixture.root, ["checkout", "--quiet", "-b", "right", base]);
    writeArticle(
      fixture.root,
      "inherited-merge-date",
      ARTICLE_A,
      "右分支仍为草稿。",
    );
    commit(fixture.root, "right remains unpublished");

    runGit(fixture.root, ["checkout", "--quiet", "left"]);
    runGit(fixture.root, [
      "merge",
      "--quiet",
      "--no-ff",
      "-s",
      "ours",
      "right",
      "-m",
      "merge published and unpublished parents",
    ]);
    const result = await checkFixture(fixture.root);
    assert.equal(result.articleCount, 1);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 merge 父历史中不同 publishedAt 失败", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "conflicting-merge-date"},
  });
  try {
    const base = runGit(fixture.root, ["rev-parse", "HEAD"]).stdout.trim();
    runGit(fixture.root, ["checkout", "--quiet", "-b", "left", base]);
    writeArticleState(fixture.root, "conflicting-merge-date", ARTICLE_A, {
      publicationStatus: "published",
      publishedAt: "2026-07-20",
    });
    commit(fixture.root, "left conflicting publication date");

    runGit(fixture.root, ["checkout", "--quiet", "-b", "right", base]);
    writeArticleState(fixture.root, "conflicting-merge-date", ARTICLE_A, {
      publicationStatus: "published",
      publishedAt: "2026-07-21",
    });
    commit(fixture.root, "right conflicting publication date");

    runGit(fixture.root, ["checkout", "--quiet", "left"]);
    runGit(fixture.root, [
      "merge",
      "--quiet",
      "--no-ff",
      "-s",
      "ours",
      "right",
      "-m",
      "merge conflicting publication dates",
    ]);
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_DATE_LINEAGE_CONFLICT",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 日期候选 API 区分 publish 与 revise 且不读取窄暂态", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "date-candidate"},
  });
  try {
    writeArticleState(fixture.root, "date-candidate", ARTICLE_A, {
      publicationStatus: "published",
      publishedAt: undefined,
      updatedAt: undefined,
    });
    const publishResult = await checkDateCandidateFixture(fixture.root, {
      action: "publish",
      articleId: ARTICLE_A,
      publishedAt: "2026-07-20",
      sourceName: "date-candidate",
    });
    assert.equal(publishResult.articleCount, 1);
    await assert.rejects(
      checkDateCandidateFixture(fixture.root, {
        action: "revise",
        articleId: ARTICLE_A,
        publishedAt: "2026-07-20",
        sourceName: "date-candidate",
      }),
      (error) => (
        error instanceof ContentHistoryError
        && error.code === "CONTENT_HISTORY_DATE_STATE"
      ),
    );

    writeArticleState(fixture.root, "date-candidate", ARTICLE_A, {
      publicationStatus: "published",
      publishedAt: "2026-07-20",
    });
    commit(fixture.root, "establish candidate publication date");
    await checkDateCandidateFixture(fixture.root, {
      action: "revise",
      articleId: ARTICLE_A,
      publishedAt: "2026-07-20",
      sourceName: "date-candidate",
    });
    await assert.rejects(
      checkDateCandidateFixture(fixture.root, {
        action: "revise",
        articleId: ARTICLE_A,
        publishedAt: "2026-07-21",
        sourceName: "date-candidate",
      }),
      (error) => (
        error instanceof ContentHistoryError
        && error.code === "CONTENT_HISTORY_DATE_CHANGED"
      ),
    );
    await assert.rejects(
      checkDateCandidateFixture(fixture.root, {
        action: "publish",
        articleId: ARTICLE_A,
        publishedAt: "2026-07-20",
        sourceName: "date-candidate",
      }),
      (error) => (
        error instanceof ContentHistoryError
        && error.code === "CONTENT_HISTORY_DATE_STATE"
      ),
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 日期候选 API 复用身份保留与删除后重引规则", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "reserved-date-candidate"},
  });
  try {
    rmSync(
      join(
        fixture.root,
        "site-content",
        "writing",
        "reserved-date-candidate",
      ),
      {recursive: true, force: true},
    );
    commit(fixture.root, "remove date candidate identity");
    await assert.rejects(
      checkDateCandidateFixture(fixture.root, {
        action: "publish",
        articleId: ARTICLE_A,
        publishedAt: "2026-07-20",
        sourceName: "replacement-date-candidate",
      }),
      (error) => (
        error instanceof ContentHistoryError
        && error.code === "CONTENT_HISTORY_ARTICLE_REINTRODUCED"
      ),
    );
    await assert.rejects(
      checkDateCandidateFixture(fixture.root, {
        action: "publish",
        articleId: ARTICLE_B,
        publishedAt: "2026-07-20",
        sourceName: "reserved-date-candidate",
      }),
      (error) => (
        error instanceof ContentHistoryError
        && error.code === "CONTENT_HISTORY_SOURCE_REUSED"
      ),
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 日期候选 API 拒绝额外字段、访问器、action 与日期", async () => {
  await assert.rejects(
    checkArticleDateHistoryCandidate({
      action: "publish",
      articleId: ARTICLE_A,
      publishedAt: "2026-07-20",
      sourceName: "extra-date-candidate",
      parser() {},
    }),
    (error) => (
      error instanceof ContentHistoryError
      && error.code === "CONTENT_HISTORY_DATE_CANDIDATE"
    ),
  );

  let accessed = false;
  const accessor = {
    action: "publish",
    articleId: ARTICLE_A,
    publishedAt: "2026-07-20",
  };
  Object.defineProperty(accessor, "sourceName", {
    enumerable: true,
    get() {
      accessed = true;
      return "accessor-date-candidate";
    },
  });
  await assert.rejects(
    checkArticleDateHistoryCandidate(accessor),
    (error) => (
      error instanceof ContentHistoryError
      && error.code === "CONTENT_HISTORY_DATE_CANDIDATE"
    ),
  );
  assert.equal(accessed, false);

  for (const invalid of [
    {
      action: "archive",
      articleId: ARTICLE_A,
      publishedAt: "2026-07-20",
      sourceName: "invalid-action",
    },
    {
      action: "publish",
      articleId: ARTICLE_A,
      publishedAt: "2026-02-30",
      sourceName: "invalid-date",
    },
  ]) {
    await assert.rejects(
      checkArticleDateHistoryCandidate(invalid),
      (error) => (
        error instanceof ContentHistoryError
        && error.code === "CONTENT_HISTORY_DATE_CANDIDATE"
      ),
    );
  }
});

test("E-013 Git 子进程环境清除继承值并精确重建七项边界", () => {
  const environment = buildContentHistoryGitEnvironment({
    CUSTOM_FIXTURE: "preserved",
    GIT_ALLOW_PROTOCOL: "file:https",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_GLOBAL: "/tmp/unsafe-global-config",
    GIT_DIR: "/tmp/unsafe-git-dir",
    LC_ALL: "en_US.UTF-8",
    PATH: "/usr/bin",
  });
  assert.deepEqual(environment, {
    CUSTOM_FIXTURE: "preserved",
    GIT_ALLOW_PROTOCOL: "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    PATH: "/usr/bin",
  });
});

test("E-013 空 writing 与完整空注册表通过生产 loader", async () => {
  const fixture = createFixture();
  try {
    writeJson(fixture.root, "docs/contracts/authors.json", {
      version: "0.1.0",
      kind: "axial_muse_authors",
      status: "active",
      owner: "AxialMuseWebsite",
      authors: {},
    });
    writeJson(fixture.root, "docs/contracts/topics.json", {
      version: "0.1.0",
      kind: "axial_muse_topics",
      status: "active",
      owner: "AxialMuseWebsite",
      topics: {},
    });
    commit(fixture.root, "empty current catalog");
    const result = await checkFixture(fixture.root);
    assert.equal(result.articleCount, 0);
    assert.equal(result.registryIdentityCount, 0);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 当前文章缺少生产必填字段时失败", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "schema-article"},
  });
  try {
    writeMinimalArticle(
      fixture.root,
      "schema-article",
      ARTICLE_A,
    );
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_CURRENT_SCHEMA",
      "site-content/writing/schema-article/index.md",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 当前工作区缺少生产注册表时失败", async () => {
  const fixture = createFixture();
  try {
    unlinkSync(join(
      fixture.root,
      "docs",
      "contracts",
      "authors.json",
    ));
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_CURRENT_SCHEMA",
      "docs/contracts/authors.json",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 当前注册表只有最小历史身份字段时仍被生产 schema 拒绝", async () => {
  const fixture = createFixture({projectIds: ["schema-project"]});
  try {
    writeJson(
      fixture.root,
      "docs/contracts/projects.json",
      {
        projects: [{
          id: "schema-project",
          writingModules: [],
        }],
      },
    );
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_CURRENT_SCHEMA",
      "docs/contracts/projects.json",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 当前内容与注册表父目录 symlink 均由生产 loader 失败关闭", async () => {
  const linkedContent = createFixture();
  const linkedContracts = createFixture();
  try {
    const outsideContent = join(linkedContent.outer, "outside-content");
    renameSync(
      join(linkedContent.root, "site-content"),
      outsideContent,
    );
    symlinkSync(
      outsideContent,
      join(linkedContent.root, "site-content"),
      "dir",
    );
    await expectHistoryError(
      linkedContent.root,
      "CONTENT_HISTORY_CURRENT_SCHEMA",
      "site-content",
    );

    const outsideDocs = join(linkedContracts.outer, "outside-docs");
    renameSync(join(linkedContracts.root, "docs"), outsideDocs);
    symlinkSync(outsideDocs, join(linkedContracts.root, "docs"), "dir");
    await expectHistoryError(
      linkedContracts.root,
      "CONTENT_HISTORY_CURRENT_SCHEMA",
      "docs/contracts",
    );
  } finally {
    destroyFixture(linkedContent);
    destroyFixture(linkedContracts);
  }
});

test("E-013 当前目录错误按 UTF-8 路径稳定选择首项", async () => {
  const fixture = createFixture();
  try {
    writeText(
      fixture.root,
      "site-content/writing/z-invalid/unexpected.txt",
      "z\n",
    );
    writeText(
      fixture.root,
      "site-content/writing/a-invalid/unexpected.txt",
      "a\n",
    );
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_CURRENT_SCHEMA",
      "site-content/writing/a-invalid",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 结构化 frontmatter 合法嵌套通过且非法 YAML 在历史与当前路径同样失败", async () => {
  const valid = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "nested-frontmatter"},
  });
  try {
    assert.equal((await checkFixture(valid.root)).articleCount, 1);
  } finally {
    destroyFixture(valid);
  }

  const historical = createFixture();
  const current = createFixture();
  try {
    const invalidText = "---\narticleId: [unterminated\n---\n";
    const historicalPath = join(
      historical.root,
      "site-content/writing/invalid-history/index.md",
    );
    mkdirSync(dirname(historicalPath), {recursive: true});
    writeFileSync(historicalPath, invalidText, "utf8");
    commit(historical.root, "invalid historical frontmatter");

    const currentPath = join(
      current.root,
      "site-content/writing/invalid-current/index.md",
    );
    mkdirSync(dirname(currentPath), {recursive: true});
    writeFileSync(currentPath, invalidText, "utf8");

    await expectHistoryError(
      historical.root,
      "CONTENT_HISTORY_FRONTMATTER",
      "site-content/writing/invalid-history/index.md",
    );
    const currentResult = runHistoryCli(current.root);
    assert.equal(currentResult.error, undefined);
    assert.equal(currentResult.signal, null);
    assert.equal(currentResult.status, 1);
    assert.equal(currentResult.stdout, "");
    assert.match(
      currentResult.stderr,
      /^\[CONTENT_HISTORY_FRONTMATTER\].*source=site-content\/writing\/invalid-current\/index\.md commit=WORKTREE\n$/u,
    );
    assert.equal(currentResult.stderr.includes(current.root), false);
  } finally {
    destroyFixture(historical);
    destroyFixture(current);
  }
});

test("E-013 冻结 frontmatter 依赖缺失在历史与当前路径同样失败", () => {
  const historical = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "historical-dependency"},
  });
  const current = createFixture();
  try {
    const historicalHead = runGit(
      historical.root,
      ["rev-parse", "HEAD"],
    ).stdout.trim();
    writeArticle(
      current.root,
      "current-dependency",
      ARTICLE_A,
    );

    const historicalResult = runHistoryCliWithoutFrozenParser(
      historical.root,
    );
    assert.equal(historicalResult.error, undefined);
    assert.equal(historicalResult.signal, null);
    assert.equal(historicalResult.status, 1);
    assert.equal(historicalResult.stdout, "");
    assert.equal(
      historicalResult.stderr,
      `[CONTENT_HISTORY_DEPENDENCY] 内容身份历史门禁未通过；source=site-content/writing/historical-dependency/index.md commit=${historicalHead}\n`,
    );
    assert.equal(historicalResult.stderr.includes(historical.root), false);

    const currentResult = runHistoryCliWithoutFrozenParser(current.root);
    assert.equal(currentResult.error, undefined);
    assert.equal(currentResult.signal, null);
    assert.equal(currentResult.status, 1);
    assert.equal(currentResult.stdout, "");
    assert.equal(
      currentResult.stderr,
      "[CONTENT_HISTORY_DEPENDENCY] 内容身份历史门禁未通过；source=site-content/writing/current-dependency/index.md commit=WORKTREE\n",
    );
    assert.equal(currentResult.stderr.includes(current.root), false);
  } finally {
    destroyFixture(historical);
    destroyFixture(current);
  }
});

test("E-013 depth-1 浅克隆失败", async () => {
  const source = createFixture();
  const outer = mkdtempSync("/tmp/axial-muse-history-shallow-");
  const shallowRoot = join(outer, "shallow");
  try {
    writeFileSync(join(source.root, "second.txt"), "second\n", "utf8");
    commit(source.root, "second commit");
    runGit(outer, [
      "clone",
      "--quiet",
      "--depth=1",
      `file://${source.root}`,
      shallowRoot,
    ]);
    await expectHistoryError(shallowRoot, "CONTENT_HISTORY_SHALLOW");
  } finally {
    destroyFixture(source);
    rmSync(outer, {recursive: true, force: true});
  }
});

test("E-013 非 Git 目录与 bare repository 失败", async () => {
  const ordinaryOuter = mkdtempSync("/tmp/axial-muse-history-ordinary-");
  const bareOuter = mkdtempSync("/tmp/axial-muse-history-bare-");
  const bareRoot = join(bareOuter, "repository.git");
  try {
    await expectHistoryError(ordinaryOuter, "CONTENT_HISTORY_WORKTREE");
    mkdirSync(bareRoot, {recursive: true});
    runGit(bareRoot, ["init", "--quiet", "--bare"]);
    await expectHistoryError(bareRoot, "CONTENT_HISTORY_WORKTREE");
  } finally {
    rmSync(ordinaryOuter, {recursive: true, force: true});
    rmSync(bareOuter, {recursive: true, force: true});
  }
});

test("E-013 缺失可达 blob 失败", async () => {
  const fixture = createFixture({
    article: {articleId: ARTICLE_A, sourceName: "missing-blob"},
  });
  try {
    const objectId = runGit(fixture.root, [
      "rev-parse",
      "HEAD:site-content/writing/missing-blob/index.md",
    ]).stdout.trim();
    const objectPath = join(
      fixture.root,
      ".git",
      "objects",
      objectId.slice(0, 2),
      objectId.slice(2),
    );
    assert.equal(existsSync(objectPath), true);
    unlinkSync(objectPath);
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_OBJECT_MISSING",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 legacy grafts 不能重写 HEAD 可达历史", async () => {
  const fixture = createFixture({projectIds: ["grafted-project"]});
  try {
    writeRegistries(fixture.root, []);
    commit(fixture.root, "remove grafted project");
    writeRegistries(fixture.root, ["grafted-project"]);
    const head = commit(fixture.root, "reintroduce grafted project");
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_REGISTRY_REINTRODUCED",
    );

    writeFileSync(
      join(fixture.root, ".git", "info", "grafts"),
      `${head}\n`,
      "utf8",
    );
    await expectHistoryError(fixture.root, "CONTENT_HISTORY_GRAFT");
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 commit-graph 不能替代 commit 对象父关系", async () => {
  const fixture = createFixture({projectIds: ["graph-project"]});
  try {
    writeRegistries(fixture.root, []);
    commit(fixture.root, "remove graph project");
    writeRegistries(fixture.root, ["graph-project"]);
    const head = commit(fixture.root, "reintroduce graph project");
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_REGISTRY_REINTRODUCED",
    );

    rewriteCommitGraphHeadAsRoot(fixture.root, head);
    assert.equal(
      runGit(
        fixture.root,
        ["rev-list", "--parents", "HEAD"],
      ).stdout.trim(),
      head,
    );
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_REGISTRY_REINTRODUCED",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 partial/promisor 配置在任何远端访问前失败", async () => {
  const fixture = createFixture();
  const sentinel = join(fixture.outer, "remote-sentinel");
  try {
    runGit(fixture.root, [
      "remote",
      "add",
      "origin",
      `ext::sh -c 'touch ${sentinel}'`,
    ]);
    runGit(fixture.root, ["config", "remote.origin.promisor", "true"]);
    await expectHistoryError(fixture.root, "CONTENT_HISTORY_PROMISOR");
    assert.equal(existsSync(sentinel), false);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 local include 不能隐藏 promisor 配置", async () => {
  const fixture = createFixture();
  try {
    writeFileSync(
      join(fixture.root, ".git", "promisor.inc"),
      '[remote "origin"]\n\tpromisor = true\n',
      "utf8",
    );
    runGit(fixture.root, ["config", "--local", "include.path", "promisor.inc"]);
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_GIT_CONFIG",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 worktree config 中的 promisor 在对象读取前失败", async () => {
  const fixture = createFixture();
  try {
    runGit(
      fixture.root,
      ["config", "--local", "extensions.worktreeConfig", "true"],
    );
    runGit(
      fixture.root,
      ["config", "--worktree", "remote.sentinel.promisor", "true"],
    );
    await expectHistoryError(fixture.root, "CONTENT_HISTORY_PROMISOR");
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 空 remote subsection 不能绕过 promisor 检查", async () => {
  const fixture = createFixture();
  try {
    runGit(
      fixture.root,
      ["config", "--local", "remote..promisor", "true"],
    );
    await expectHistoryError(fixture.root, "CONTENT_HISTORY_PROMISOR");
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 config subsection 控制字符不能绕过 promisor 检查", async () => {
  const fixture = createFixture();
  try {
    runGit(
      fixture.root,
      ["config", "--local", "remote.a\rb.promisor", "true"],
    );
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_GIT_CONFIG",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 partial clone extension 失败", async () => {
  const fixture = createFixture();
  try {
    runGit(fixture.root, ["config", "core.repositoryFormatVersion", "1"]);
    runGit(fixture.root, ["config", "extensions.partialClone", "origin"]);
    await expectHistoryError(
      fixture.root,
      "CONTENT_HISTORY_PARTIAL_CLONE",
    );
  } finally {
    destroyFixture(fixture);
  }
});

test("E-013 promisor pack 与 alternate object database 均在对象读取前失败", async () => {
  const promisor = createFixture();
  const alternate = createFixture();
  try {
    const packPath = join(
      promisor.root,
      ".git",
      "objects",
      "pack",
      "fixture.promisor",
    );
    writeFileSync(packPath, "", "utf8");
    await expectHistoryError(promisor.root, "CONTENT_HISTORY_PROMISOR");

    const alternatePath = join(
      alternate.root,
      ".git",
      "objects",
      "info",
      "alternates",
    );
    writeFileSync(alternatePath, `${promisor.root}/.git/objects\n`, "utf8");
    await expectHistoryError(alternate.root, "CONTENT_HISTORY_ALTERNATE");
  } finally {
    destroyFixture(promisor);
    destroyFixture(alternate);
  }
});

test("E-013 共享入口拒绝 parser 注入", async () => {
  let parserCalled = false;
  await assert.rejects(
    checkContentHistory({
      parser() {
        parserCalled = true;
      },
    }),
    (error) => (
      error instanceof ContentHistoryError
      && error.code === "CONTENT_HISTORY_ARGUMENTS"
    ),
  );
  assert.equal(parserCalled, false);
});

test("E-013 CLI 参数边界失败关闭", async () => {
  const fixture = createFixture();
  const previousCwd = process.cwd();
  process.chdir(fixture.root);
  try {
    await assert.rejects(
      checkContentHistory({arguments_: ["HEAD"]}),
      (error) => (
        error instanceof ContentHistoryError
        && error.code === "CONTENT_HISTORY_ARGUMENTS"
      ),
    );
  } finally {
    process.chdir(previousCwd);
    destroyFixture(fixture);
  }
});

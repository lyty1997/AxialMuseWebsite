import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {decodeFrontMatter} from "../../scripts/content/frontmatter.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CREATE_ARTICLE_CLI = resolve(ROOT, "scripts/author/create-article.mjs");
const HISTORY_CLI = resolve(ROOT, "scripts/quality/check-content-history.mjs");
const SOURCE_NAME = "atomic-author-fixture";
const SECOND_AUTHOR_ID = "author-fixture";
const TOPIC_IDS = Object.freeze([
  "author-fixture-primary",
  "author-fixture-secondary",
]);
const ARGUMENTS = Object.freeze([
  "--source-name",
  SOURCE_NAME,
  "--title",
  "原子作者命令集成验收",
  "--slug",
  "/writing/independent-author-route",
  "--summary",
  "这是一段用于真实作者命令集成验收并且长度足够的可信摘要。",
  "--author",
  "lyty1997",
  "--author",
  SECOND_AUTHOR_ID,
  "--topic",
  TOPIC_IDS[0],
  "--topic",
  TOPIC_IDS[1],
]);

function gitEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function run(command, arguments_, {
  allowFailure = false,
  cwd = ROOT,
} = {}) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
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
    throw new Error(`fixture command failed: ${command}`);
  }
  return result;
}

function createGitFixture() {
  const parent = mkdtempSync(join(tmpdir(), "axial-muse-author-integration-"));
  const root = resolve(parent, "repository");
  run("git", [
    "clone",
    "--local",
    "--no-hardlinks",
    "--no-tags",
    ROOT,
    root,
  ]);

  const topicsPath = resolve(root, "docs/contracts/topics.json");
  const topics = JSON.parse(readFileSync(topicsPath, "utf8"));
  topics.topics[TOPIC_IDS[0]] = {
    displayName: "作者命令主主题",
    navigationOrder: 10,
    status: "active",
  };
  topics.topics[TOPIC_IDS[1]] = {
    displayName: "作者命令次主题",
    navigationOrder: 20,
    status: "active",
  };
  writeFileSync(topicsPath, `${JSON.stringify(topics, null, 2)}\n`, "utf8");
  const authorsPath = resolve(root, "docs/contracts/authors.json");
  const authors = JSON.parse(readFileSync(authorsPath, "utf8"));
  authors.authors[SECOND_AUTHOR_ID] = {
    displayName: "Author Fixture",
  };
  writeFileSync(authorsPath, `${JSON.stringify(authors, null, 2)}\n`, "utf8");
  run(
    "git",
    ["add", "docs/contracts/authors.json", "docs/contracts/topics.json"],
    {cwd: root},
  );
  run("git", [
    "-c",
    "user.name=Axial Muse Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "test: add author fixture topic",
  ], {cwd: root});
  return {parent, root};
}

test("CODE-014 真实 CLI 在完整 Git fixture 原子创建且由 I-06/E-013 原样读回", async () => {
  const fixture = createGitFixture();
  try {
    const result = run(process.execPath, [CREATE_ARTICLE_CLI, ...ARGUMENTS], {
      allowFailure: true,
      cwd: fixture.root,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");

    const sourcePath = `site-content/writing/${SOURCE_NAME}/index.md`;
    const absolutePath = resolve(fixture.root, sourcePath);
    const source = readFileSync(absolutePath, "utf8");
    const decoded = await decodeFrontMatter({
      fileContent: source,
      filePath: absolutePath,
      sourcePath,
    });
    assert.match(
      decoded.frontMatter.articleId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    assert.deepEqual(decoded.frontMatter, {
      articleId: decoded.frontMatter.articleId,
      title: "原子作者命令集成验收",
      slug: "/writing/independent-author-route",
      summary: "这是一段用于真实作者命令集成验收并且长度足够的可信摘要。",
      publicationStatus: "draft",
      authors: ["lyty1997", SECOND_AUTHOR_ID],
      classification: {
        topics: [...TOPIC_IDS],
      },
    });
    assert.doesNotMatch(source, /publishedAt|updatedAt/u);

    const history = run(process.execPath, [HISTORY_CLI], {
      allowFailure: true,
      cwd: fixture.root,
    });
    assert.equal(history.status, 0, history.stderr);
    assert.match(history.stdout, /^Content history checks passed:/u);
    assert.equal(history.stderr, "");

    const status = run("git", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ], {cwd: fixture.root});
    assert.equal(status.stdout, `?? ${sourcePath}\n`);
    assert.equal(
      run("git", ["diff", "--cached", "--quiet"], {
        allowFailure: true,
        cwd: fixture.root,
      }).status,
      0,
    );
    assert.equal(
      existsSync(resolve(fixture.root, ".axial-muse-author.lock")),
      false,
    );
    assert.deepEqual(
      readdirSync(resolve(fixture.root, "site-content"))
        .filter((name) => name.startsWith(".author-staging-")),
      [],
    );

    const before = Buffer.from(source);
    const duplicate = run(
      process.execPath,
      [CREATE_ARTICLE_CLI, ...ARGUMENTS],
      {allowFailure: true, cwd: fixture.root},
    );
    assert.equal(duplicate.status, 1);
    assert.equal(duplicate.stdout, "");
    assert.match(duplicate.stderr, /^\[AUTHOR_TARGET_EXISTS\]/u);
    assert.equal(duplicate.stderr.includes(fixture.root), false);
    assert.deepEqual(readFileSync(absolutePath), before);
  } finally {
    rmSync(fixture.parent, {recursive: true, force: true});
  }
});

test("CODE-014 真实 CLI 拒绝复用已从 Git 历史删除的 source-name", () => {
  const fixture = createGitFixture();
  const sourcePath = `site-content/writing/${SOURCE_NAME}/index.md`;
  const absolutePath = resolve(fixture.root, sourcePath);
  try {
    mkdirSync(resolve(absolutePath, ".."), {recursive: true});
    writeFileSync(
      absolutePath,
      `---
articleId: "018f0000-0000-7000-8000-000000000099"
title: "历史身份占位文章"
slug: "/writing/atomic-author-fixture"
summary: "这是一段用于证明 source-name 一经进入 Git 历史便不得复用的可信摘要。"
publicationStatus: "draft"
authors:
  - "lyty1997"
  - "${SECOND_AUTHOR_ID}"
classification:
  topics:
    - "${TOPIC_IDS[0]}"
    - "${TOPIC_IDS[1]}"
---

历史身份占位正文。
`,
      "utf8",
    );
    run("git", ["add", sourcePath], {cwd: fixture.root});
    run("git", [
      "-c",
      "user.name=Axial Muse Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "test: reserve historical article source",
    ], {cwd: fixture.root});
    run("git", ["rm", sourcePath], {cwd: fixture.root});
    run("git", [
      "-c",
      "user.name=Axial Muse Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "test: remove historical article source",
    ], {cwd: fixture.root});

    const result = run(
      process.execPath,
      [CREATE_ARTICLE_CLI, ...ARGUMENTS],
      {allowFailure: true, cwd: fixture.root},
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^\[CONTENT_HISTORY_SOURCE_REUSED\]/u);
    assert.equal(result.stderr.includes(fixture.root), false);
    assert.equal(existsSync(absolutePath), false);
    assert.equal(
      existsSync(resolve(fixture.root, ".axial-muse-author.lock")),
      false,
    );
    assert.deepEqual(
      readdirSync(resolve(fixture.root, "site-content"))
        .filter((name) => name.startsWith(".author-staging-")),
      [],
    );
    assert.equal(
      run("git", ["status", "--porcelain=v1"], {cwd: fixture.root}).stdout,
      "",
    );
  } finally {
    rmSync(fixture.parent, {recursive: true, force: true});
  }
});

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PUBLISH_SOURCE_NAME = "date-publish-fixture";
const REVISE_SOURCE_NAME = "date-revise-fixture";
const TOPIC_ID = "date-command-fixture";
const PUBLISH_ARTICLE_ID = "018f0000-0000-7000-8000-000000000025";
const REVISE_ARTICLE_ID = "018f0000-0000-7000-8000-000000000125";
const OVERLAY_PATHS = Object.freeze([
  "scripts/author/create-article.mjs",
  "scripts/author/lib/article-date-edit.mjs",
  "scripts/author/set-article-dates.mjs",
  "scripts/quality/lib/content-history.mjs",
]);

function childEnvironment(overrides = {}) {
  const environment = {};
  for (const key of [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TEMP",
    "TMP",
    "TMPDIR",
  ]) {
    if (typeof process.env[key] === "string") {
      environment[key] = process.env[key];
    }
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...overrides,
  };
}

function run(command, arguments_, {
  allowFailure = false,
  cwd = ROOT,
  environment = {},
} = {}) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: childEnvironment(environment),
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

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isFrozenNodeModules(candidate, expectedLock) {
  if (!existsSync(resolve(candidate, "@docusaurus/utils/package.json"))) {
    return false;
  }
  const installedLock = readJson(resolve(candidate, ".package-lock.json"));
  if (
    installedLock === null
    || installedLock.name !== expectedLock.name
    || installedLock.version !== expectedLock.version
    || installedLock.lockfileVersion !== expectedLock.lockfileVersion
    || installedLock.requires !== expectedLock.requires
    || typeof installedLock.packages !== "object"
    || installedLock.packages === null
  ) {
    return false;
  }
  const expectedPackages = expectedLock.packages;
  if (
    typeof expectedPackages !== "object"
    || expectedPackages === null
    || Object.entries(installedLock.packages).some(([path, value]) => (
      !Object.hasOwn(expectedPackages, path)
      || JSON.stringify(value) !== JSON.stringify(expectedPackages[path])
    ))
  ) {
    return false;
  }
  return Object.entries(expectedPackages).every(([path, value]) => (
    path === ""
    || Object.hasOwn(installedLock.packages, path)
    || value?.optional === true
  ));
}

function findFrozenNodeModules() {
  const expectedLock = readJson(resolve(ROOT, "package-lock.json"));
  assert.notEqual(
    expectedLock,
    null,
    "日期命令集成验收需要合法的根 package-lock.json。",
  );
  const candidates = [resolve(ROOT, "node_modules")];
  const temporaryEntries = readdirSync(tmpdir(), {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(tmpdir(), entry.name))
    .sort();
  for (const entry of temporaryEntries) {
    for (const suffix of [
      "node_modules",
      "repo/node_modules",
      "minimum/node_modules",
      "primary/node_modules",
      "primary-final/node_modules",
      "runtime/node_modules",
    ]) {
      candidates.push(resolve(entry, suffix));
    }
  }
  const match = candidates.find((candidate) => (
    isFrozenNodeModules(candidate, expectedLock)
  ));
  assert.notEqual(
    match,
    undefined,
    "日期命令集成验收需要已冻结且已安装的 node_modules。",
  );
  return match;
}

function articleSource({
  articleId,
  publishedAt,
  publicationStatus,
  sourceName,
  updatedAt,
}) {
  return [
    "---",
    `articleId: "${articleId}"`,
    `title: "Fixture ${sourceName}"`,
    `slug: "/writing/${sourceName}"`,
    `summary: "A traceable date command article for ${sourceName} with sufficient evidence."`,
    `publicationStatus: "${publicationStatus}"`,
    ...(publishedAt === undefined
      ? []
      : [`publishedAt: "${publishedAt}"`]),
    ...(updatedAt === undefined
      ? []
      : [`updatedAt: "${updatedAt}"`]),
    "authors:",
    '  - "lyty1997"',
    "classification:",
    "  topics:",
    `    - "${TOPIC_ID}"`,
    "---",
    "",
    "## 技术问题",
    "",
    "这是一段可复核的日期命令集成 fixture 正文。",
    "",
  ].join("\n");
}

function articlePath(root, sourceName) {
  return resolve(
    root,
    "site-content",
    "writing",
    sourceName,
    "index.md",
  );
}

function writeArticle(root, options) {
  const target = articlePath(root, options.sourceName);
  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, articleSource(options), "utf8");
}

function replaceExact(source, before, after) {
  assert.equal(source.split(before).length, 2);
  return source.replace(before, after);
}

function shanghaiDate(epochMilliseconds = Date.now()) {
  const parts = new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).formatToParts(new Date(epochMilliseconds));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function previousDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function commit(root, message) {
  run("git", ["add", "--all"], {cwd: root});
  run("git", [
    "-c",
    "user.name=Axial Muse Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    message,
  ], {cwd: root});
}

function assertNoResidue(root) {
  assert.equal(existsSync(resolve(root, ".axial-muse-author.lock")), false);
  assert.deepEqual(
    readdirSync(resolve(root, "site-content"))
      .filter((name) => name.startsWith(".author-staging-")),
    [],
  );
}

function assertHistoryPasses(root) {
  const history = run(
    process.execPath,
    [resolve(root, "scripts/quality/check-content-history.mjs")],
    {allowFailure: true, cwd: root},
  );
  assert.equal(history.status, 0, history.stderr);
  assert.equal(history.stderr, "");
  assert.match(history.stdout, /^Content history checks passed:/u);
}

function runDateCli(root, sourceName, action, options = {}) {
  return run(
    process.execPath,
    [
      resolve(root, "scripts/author/set-article-dates.mjs"),
      "--source-name",
      sourceName,
      "--action",
      action,
    ],
    {allowFailure: true, cwd: root, ...options},
  );
}

function createFixture() {
  const parent = mkdtempSync(join(tmpdir(), "axial-muse-date-integration-"));
  const root = resolve(parent, "repository");
  try {
    run("git", [
      "clone",
      "--local",
      "--no-hardlinks",
      "--no-tags",
      ROOT,
      root,
    ]);

    for (const sourcePath of OVERLAY_PATHS) {
      const target = resolve(root, sourcePath);
      mkdirSync(dirname(target), {recursive: true});
      copyFileSync(resolve(ROOT, sourcePath), target);
    }
    symlinkSync(findFrozenNodeModules(), resolve(root, "node_modules"), "dir");

    const topicsPath = resolve(root, "docs/contracts/topics.json");
    const topics = JSON.parse(readFileSync(topicsPath, "utf8"));
    topics.topics[TOPIC_ID] = {
      displayName: "日期命令验收",
      navigationOrder: 10,
      status: "active",
    };
    writeFileSync(topicsPath, `${JSON.stringify(topics, null, 2)}\n`, "utf8");

    const initialToday = shanghaiDate();
    writeArticle(root, {
      articleId: PUBLISH_ARTICLE_ID,
      publicationStatus: "draft",
      sourceName: PUBLISH_SOURCE_NAME,
    });
    writeArticle(root, {
      articleId: REVISE_ARTICLE_ID,
      publicationStatus: "published",
      publishedAt: previousDate(initialToday),
      sourceName: REVISE_SOURCE_NAME,
      updatedAt: previousDate(initialToday),
    });
    commit(root, "test: add date command integration baseline");
    return {parent, root};
  } catch (error) {
    rmSync(parent, {recursive: true, force: true});
    throw error;
  }
}

test("D-106 真实日期 CLI 覆盖 publish、同日无写、跨日 revise 与 CI 拒绝", () => {
  const fixture = createFixture();
  try {
    const publishPath = articlePath(fixture.root, PUBLISH_SOURCE_NAME);
    const draftSource = readFileSync(publishPath, "utf8");
    const publishInput = replaceExact(
      draftSource,
      'publicationStatus: "draft"',
      'publicationStatus: "published"',
    );
    writeFileSync(publishPath, publishInput, "utf8");

    const publish = runDateCli(
      fixture.root,
      PUBLISH_SOURCE_NAME,
      "publish",
    );
    assert.equal(publish.status, 0, publish.stderr);
    assert.equal(publish.stdout, "");
    assert.equal(publish.stderr, "");
    const publishedSource = readFileSync(publishPath, "utf8");
    const publishedDateMatch = publishedSource.match(
      /publishedAt: "(\d{4}-\d{2}-\d{2})"\nupdatedAt: "\1"/u,
    );
    assert.notEqual(publishedDateMatch, null);
    const publishedDate = publishedDateMatch[1];
    assert.equal(
      publishedSource,
      replaceExact(
        publishInput,
        'publicationStatus: "published"',
        [
          'publicationStatus: "published"',
          `publishedAt: "${publishedDate}"`,
          `updatedAt: "${publishedDate}"`,
        ].join("\n"),
      ),
    );
    assert.equal(
      run("git", [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ], {cwd: fixture.root}).stdout,
      ` M site-content/writing/${PUBLISH_SOURCE_NAME}/index.md\n`,
    );
    assertHistoryPasses(fixture.root);
    assertNoResidue(fixture.root);
    commit(fixture.root, "test: publish date fixture");

    const sameDayBefore = readFileSync(publishPath);
    const sameDayMode = lstatSync(publishPath).mode;
    const sameDay = runDateCli(
      fixture.root,
      PUBLISH_SOURCE_NAME,
      "revise",
    );
    assert.equal(sameDay.status, 0, sameDay.stderr);
    assert.equal(sameDay.stdout, "");
    assert.equal(sameDay.stderr, "");
    assert.deepEqual(readFileSync(publishPath), sameDayBefore);
    assert.equal(lstatSync(publishPath).mode, sameDayMode);
    assert.equal(
      run("git", ["status", "--porcelain=v1"], {
        cwd: fixture.root,
      }).stdout,
      "",
    );
    assertHistoryPasses(fixture.root);
    assertNoResidue(fixture.root);

    const revisePath = articlePath(fixture.root, REVISE_SOURCE_NAME);
    const reviseBeforeEdit = readFileSync(revisePath, "utf8");
    const historicalDate = reviseBeforeEdit.match(
      /publishedAt: "(\d{4}-\d{2}-\d{2})"/u,
    )[1];
    const reviseInput = replaceExact(
      reviseBeforeEdit,
      "这是一段可复核的日期命令集成 fixture 正文。",
      "这是一段可复核的日期命令集成 fixture 修订正文。",
    );
    writeFileSync(revisePath, reviseInput, "utf8");
    const revise = runDateCli(
      fixture.root,
      REVISE_SOURCE_NAME,
      "revise",
    );
    assert.equal(revise.status, 0, revise.stderr);
    assert.equal(revise.stdout, "");
    assert.equal(revise.stderr, "");
    const revisedSource = readFileSync(revisePath, "utf8");
    const revisedDate = revisedSource.match(
      /updatedAt: "(\d{4}-\d{2}-\d{2})"/u,
    )[1];
    assert.equal(revisedDate > historicalDate, true);
    assert.equal(
      revisedSource,
      replaceExact(
        reviseInput,
        `updatedAt: "${historicalDate}"`,
        `updatedAt: "${revisedDate}"`,
      ),
    );
    assertHistoryPasses(fixture.root);
    assertNoResidue(fixture.root);
    commit(fixture.root, "test: revise date fixture");

    const ciBefore = readFileSync(revisePath);
    const ciMode = lstatSync(revisePath).mode;
    const ciResult = runDateCli(
      fixture.root,
      REVISE_SOURCE_NAME,
      "revise",
      {environment: {CI: "true"}},
    );
    assert.equal(ciResult.status, 1);
    assert.equal(ciResult.stdout, "");
    assert.match(ciResult.stderr, /^\[AUTHOR_DATE_AUTOMATION\]/u);
    assert.equal(ciResult.stderr.includes(fixture.root), false);
    assert.deepEqual(readFileSync(revisePath), ciBefore);
    assert.equal(lstatSync(revisePath).mode, ciMode);
    assert.equal(
      run("git", ["status", "--porcelain=v1"], {
        cwd: fixture.root,
      }).stdout,
      "",
    );
    assertNoResidue(fixture.root);
  } finally {
    rmSync(fixture.parent, {recursive: true, force: true});
  }
});

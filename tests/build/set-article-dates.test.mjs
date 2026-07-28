import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {
  parseSetArticleDatesArguments,
  setArticleDates,
  SetArticleDatesError,
} from "../../scripts/author/set-article-dates.mjs";
import {ContentHistoryError} from "../../scripts/quality/lib/content-history.mjs";
import "./run-set-article-dates-tests.test.mjs";

const ARTICLE_ID = "018f0000-0000-7000-8000-000000000025";
const FIXTURE_HEAD = "a".repeat(40);
const OWNER = "d".repeat(64);
const SOURCE_NAME = "date-transaction-fixture";
const TODAY_MILLISECONDS = Date.UTC(2026, 6, 27, 16, 0, 0, 0);

function articleSource({
  extension = "md",
  publicationStatus = "published",
  publishedAt,
  updatedAt,
} = {}) {
  return {
    extension,
    text: [
      "---",
      `articleId: "${ARTICLE_ID}"`,
      '"title": "日期事务 fixture"',
      `publicationStatus: "${publicationStatus}"`,
      ...(publishedAt === undefined
        ? []
        : [`publishedAt: "${publishedAt}"`]),
      ...(updatedAt === undefined
        ? []
        : [`updatedAt: "${updatedAt}"`]),
      "metadata:",
      '  updatedAt: "nested-value"',
      "---",
      "",
      "## 正文",
      "",
      'updatedAt: "body-example"',
      "",
    ].join("\n"),
  };
}

function createFixture(source = articleSource(), {mode = 0o640} = {}) {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-date-command-"));
  writeFileSync(resolve(root, ".nvmrc"), `${process.versions.node}\n`, "utf8");
  const sourcePath =
    `site-content/writing/${SOURCE_NAME}/index.${source.extension}`;
  const path = resolve(root, sourcePath);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, source.text, "utf8");
  chmodSync(path, mode);
  return {mode, path, root, sourcePath};
}

function destroyFixture(fixture) {
  rmSync(fixture.root, {recursive: true, force: true});
}

function decodeFixture({fileContent}) {
  const closingStart = fileContent.indexOf("\n---\n", 4);
  if (!fileContent.startsWith("---\n") || closingStart < 4) {
    throw new TypeError("invalid fixture frontmatter");
  }
  const frontMatter = {};
  for (const line of fileContent.slice(4, closingStart).split("\n")) {
    const match =
      /^(articleId|publicationStatus|publishedAt|updatedAt): ("(?:[^"\\]|\\.)*")$/u
        .exec(line);
    if (match !== null) frontMatter[match[1]] = JSON.parse(match[2]);
  }
  return Object.freeze({
    content: fileContent.slice(closingStart + 5),
    frontMatter: Object.freeze(frontMatter),
  });
}

function dependencies(overrides = {}) {
  return {
    async checkHistory() {
      return {head: FIXTURE_HEAD};
    },
    async checkHistoryCandidate() {
      return {head: FIXTURE_HEAD};
    },
    createOwner() {
      return OWNER;
    },
    async decodeArticle(options) {
      return decodeFixture(options);
    },
    nowMilliseconds() {
      return TODAY_MILLISECONDS;
    },
    readHead() {
      return FIXTURE_HEAD;
    },
    ...overrides,
  };
}

function commandArguments(action) {
  return [
    "--source-name",
    SOURCE_NAME,
    "--action",
    action,
  ];
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

function residue(root) {
  return {
    lock: existsSync(resolve(root, ".axial-muse-author.lock")),
    staging: readdirSync(resolve(root, "site-content"))
      .filter((name) => name.startsWith(".author-staging-")),
  };
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

async function expectUnchangedFailure(fixture, action, code) {
  const before = {
    bytes: readFileSync(fixture.path),
    digest: digest(fixture.path),
    mode: mode(fixture.path),
  };
  await expectCode(action, code);
  assert.deepEqual(readFileSync(fixture.path), before.bytes);
  assert.equal(digest(fixture.path), before.digest);
  assert.equal(mode(fixture.path), before.mode);
  assert.deepEqual(residue(fixture.root), {lock: false, staging: []});
}

test("D-106 日期命令参数完整显式且不接受默认或修正", () => {
  assert.deepEqual(
    parseSetArticleDatesArguments(commandArguments("publish")),
    {action: "publish", sourceName: SOURCE_NAME},
  );
  assert.deepEqual(
    parseSetArticleDatesArguments([
      "--action",
      "revise",
      "--source-name",
      SOURCE_NAME,
    ]),
    {action: "revise", sourceName: SOURCE_NAME},
  );
  for (const arguments_ of [
    [],
    ["--source-name", SOURCE_NAME],
    [...commandArguments("publish"), "extra"],
    ["--source-name", SOURCE_NAME, "--source-name", SOURCE_NAME],
    ["--source-name", SOURCE_NAME, "--action=publish", "ignored"],
    ["--source-name", "Date-Transaction", "--action", "publish"],
    ["--source-name", ` ${SOURCE_NAME}`, "--action", "publish"],
    ["--source-name", SOURCE_NAME, "--action", "Publish"],
    ["--source-name", SOURCE_NAME, "--action", "archive"],
  ]) {
    assert.throws(
      () => parseSetArticleDatesArguments(arguments_),
      (error) => (
        error instanceof SetArticleDatesError
        && error.code === "AUTHOR_DATE_ARGUMENTS"
      ),
    );
  }
});

test("D-106 publish 原子写入同一上海日期并保持其余字节与 mode", async () => {
  const fixture = createFixture();
  const calls = [];
  try {
    const before = readFileSync(fixture.path, "utf8");
    const result = await setArticleDates({
      arguments_: commandArguments("publish"),
      dependencies: dependencies({
        async checkHistory() {
          calls.push("history");
          const current = readFileSync(fixture.path, "utf8");
          assert.match(current, /^publishedAt: "2026-07-28"$/mu);
          assert.match(current, /^updatedAt: "2026-07-28"$/mu);
          return {head: FIXTURE_HEAD};
        },
        async checkHistoryCandidate(candidate) {
          calls.push(["candidate", candidate]);
          return {head: FIXTURE_HEAD};
        },
      }),
      environment: {},
      root: fixture.root,
    });
    assert.deepEqual(result, {
      action: "publish",
      changed: true,
      publishedAt: "2026-07-28",
      sourcePath: fixture.sourcePath,
      updatedAt: "2026-07-28",
    });
    assert.deepEqual(calls, [
      ["candidate", {
        action: "publish",
        articleId: ARTICLE_ID,
        publishedAt: "2026-07-28",
        sourceName: SOURCE_NAME,
      }],
      "history",
    ]);
    const expected = before.replace(
      'publicationStatus: "published"',
      'publicationStatus: "published"\npublishedAt: "2026-07-28"\nupdatedAt: "2026-07-28"',
    );
    assert.equal(readFileSync(fixture.path, "utf8"), expected);
    assert.equal(mode(fixture.path), fixture.mode);
    assert.deepEqual(residue(fixture.root), {lock: false, staging: []});
  } finally {
    destroyFixture(fixture);
  }
});

test("D-106 revise 只改 updatedAt，MDX 与同日无写路径均受完整历史校验", async () => {
  const revise = createFixture(articleSource({
    extension: "mdx",
    publishedAt: "2026-07-20",
    updatedAt: "2026-07-27",
  }));
  const sameDay = createFixture(articleSource({
    publishedAt: "2026-07-20",
    updatedAt: "2026-07-28",
  }));
  try {
    const reviseBefore = readFileSync(revise.path, "utf8");
    const revised = await setArticleDates({
      arguments_: commandArguments("revise"),
      dependencies: dependencies(),
      environment: {},
      root: revise.root,
    });
    assert.equal(revised.changed, true);
    assert.equal(revised.sourcePath.endsWith("/index.mdx"), true);
    assert.equal(
      readFileSync(revise.path, "utf8"),
      reviseBefore.replace(
        'updatedAt: "2026-07-27"\nmetadata:',
        'updatedAt: "2026-07-28"\nmetadata:',
      ),
    );

    const sameDayBefore = {
      bytes: readFileSync(sameDay.path),
      inode: lstatSync(sameDay.path).ino,
      mode: mode(sameDay.path),
    };
    let historyCalls = 0;
    const noWrite = await setArticleDates({
      arguments_: commandArguments("revise"),
      dependencies: dependencies({
        async checkHistory() {
          historyCalls += 1;
          return {head: FIXTURE_HEAD};
        },
      }),
      environment: {},
      root: sameDay.root,
    });
    assert.equal(noWrite.changed, false);
    assert.equal(historyCalls, 1);
    assert.deepEqual(readFileSync(sameDay.path), sameDayBefore.bytes);
    assert.equal(lstatSync(sameDay.path).ino, sameDayBefore.inode);
    assert.equal(mode(sameDay.path), sameDayBefore.mode);
    assert.deepEqual(residue(sameDay.root), {lock: false, staging: []});
  } finally {
    destroyFixture(revise);
    destroyFixture(sameDay);
  }
});

test("D-106 状态、时钟、历史候选与 CI 拒绝都保持源文件不变", async () => {
  const cases = [
    {
      source: articleSource({publicationStatus: "draft"}),
      code: "AUTHOR_DATE_STATE",
      action: "publish",
      overrides: {},
    },
    {
      source: articleSource({publicationStatus: "archived"}),
      code: "AUTHOR_DATE_STATE",
      action: "publish",
      overrides: {},
    },
    {
      source: articleSource({publishedAt: "2026-07-27"}),
      code: "AUTHOR_DATE_STATE",
      action: "publish",
      overrides: {},
    },
    {
      source: articleSource({
        publishedAt: "2026-07-20",
        updatedAt: "2026-07-29",
      }),
      code: "AUTHOR_DATE_CLOCK",
      action: "revise",
      overrides: {},
    },
    {
      source: articleSource(),
      code: "AUTHOR_DATE_STATE",
      action: "publish",
      overrides: {
        async checkHistoryCandidate() {
          throw new ContentHistoryError("CONTENT_HISTORY_DATE_STATE");
        },
      },
    },
  ];
  for (const fixtureCase of cases) {
    const fixture = createFixture(fixtureCase.source);
    try {
      await expectUnchangedFailure(
        fixture,
        () => setArticleDates({
          arguments_: commandArguments(fixtureCase.action),
          dependencies: dependencies(fixtureCase.overrides),
          environment: {},
          root: fixture.root,
        }),
        fixtureCase.code,
      );
    } finally {
      destroyFixture(fixture);
    }
  }

  for (const environment of [
    {CI: "true"},
    {GITHUB_ACTIONS: "1"},
    {RUNNER_OS: "Linux"},
  ]) {
    const fixture = createFixture();
    try {
      await expectUnchangedFailure(
        fixture,
        () => setArticleDates({
          arguments_: commandArguments("publish"),
          dependencies: dependencies(),
          environment,
          root: fixture.root,
        }),
        "AUTHOR_DATE_AUTOMATION",
      );
    } finally {
      destroyFixture(fixture);
    }
  }
});

test("D-106 写入、flush、rename、终态与 commit 前故障全部回滚原字节", async () => {
  const failures = [
    ["beforeOriginalWrite", "AUTHOR_WRITE"],
    ["beforeCandidateWrite", "AUTHOR_WRITE"],
    ["beforeFileFlush", "AUTHOR_FILE_FLUSH"],
    ["beforeStagingDirectoryFlush", "AUTHOR_DIRECTORY_FLUSH"],
    ["beforeSourceReplace", "AUTHOR_RENAME"],
    ["afterSourceReplace", "AUTHOR_DATE_CONTENT"],
    ["beforeArticleDirectoryFlush", "AUTHOR_DIRECTORY_FLUSH"],
    ["beforeFinalHistoryCheck", "AUTHOR_DATE_CONTENT"],
    ["beforeStagingCleanup", "AUTHOR_DATE_CONTENT"],
    ["beforeLockRelease", "AUTHOR_DATE_DRIFT"],
  ];
  for (const [hookName, code] of failures) {
    const fixture = createFixture();
    try {
      await expectUnchangedFailure(
        fixture,
        () => setArticleDates({
          arguments_: commandArguments("publish"),
          dependencies: dependencies(),
          environment: {},
          root: fixture.root,
          testHooks: {
            [hookName]() {
              throw new Error(`synthetic ${hookName}`);
            },
          },
        }),
        code,
      );
    } finally {
      destroyFixture(fixture);
    }
  }

  const historyFailure = createFixture();
  try {
    await expectUnchangedFailure(
      historyFailure,
      () => setArticleDates({
        arguments_: commandArguments("publish"),
        dependencies: dependencies({
          async checkHistory() {
            throw new Error("synthetic full history failure");
          },
        }),
        environment: {},
        root: historyFailure.root,
      }),
      "AUTHOR_DATE_CONTENT",
    );
  } finally {
    destroyFixture(historyFailure);
  }
});

test("D-106 rename 已生效后抛错仍按实际所有权完成回滚", async () => {
  for (const failurePoint of ["activate", "rollback"]) {
    const fixture = createFixture();
    let renameCalls = 0;
    try {
      await expectUnchangedFailure(
        fixture,
        () => setArticleDates({
          arguments_: commandArguments("publish"),
          dependencies: dependencies({
            async checkHistory() {
              if (failurePoint === "rollback") {
                throw new Error("force rollback");
              }
              return {head: FIXTURE_HEAD};
            },
            renameFile(source, target) {
              renameSync(source, target);
              renameCalls += 1;
              if (
                (failurePoint === "activate" && renameCalls === 1)
                || (failurePoint === "rollback" && renameCalls === 2)
              ) {
                throw new Error(`effect-then-throw ${failurePoint}`);
              }
            },
          }),
          environment: {},
          root: fixture.root,
        }),
        failurePoint === "activate"
          ? "AUTHOR_RENAME"
          : "AUTHOR_DATE_CONTENT",
      );
      assert.equal(renameCalls, 2);
    } finally {
      destroyFixture(fixture);
    }
  }
});

test("D-106 commit point 内重新核对 HEAD，漂移时恢复原文后释放锁", async () => {
  const fixture = createFixture();
  let headReads = 0;
  try {
    await expectUnchangedFailure(
      fixture,
      () => setArticleDates({
        arguments_: commandArguments("publish"),
        dependencies: dependencies({
          readHead() {
            headReads += 1;
            return headReads < 3 ? FIXTURE_HEAD : "b".repeat(40);
          },
        }),
        environment: {},
        root: fixture.root,
      }),
      "AUTHOR_LOCK_RELEASE",
    );
    assert.equal(headReads, 3);
  } finally {
    destroyFixture(fixture);
  }
});

test("D-106 commit point 内拒绝 target、build lock 与 author lock 漂移", async () => {
  for (const kind of ["target", "build", "author"]) {
    const fixture = createFixture();
    const authorLock = resolve(fixture.root, ".axial-muse-author.lock");
    try {
      await expectCode(
        () => setArticleDates({
          arguments_: commandArguments("publish"),
          dependencies: dependencies({
            releaseLockBoundary() {
              if (kind === "target") {
                writeFileSync(fixture.path, "external target\n", "utf8");
              } else if (kind === "build") {
                writeFileSync(
                  resolve(fixture.root, ".axial-muse-build.lock"),
                  "external build\n",
                  "utf8",
                );
              } else {
                writeFileSync(authorLock, "external author lock\n", "utf8");
              }
            },
          }),
          environment: {},
          root: fixture.root,
        }),
        "AUTHOR_ROLLBACK",
      );
      assert.equal(existsSync(authorLock), true);
      if (kind === "target") {
        assert.equal(readFileSync(fixture.path, "utf8"), "external target\n");
      } else {
        assert.match(
          readFileSync(fixture.path, "utf8"),
          /^publishedAt: "2026-07-28"$/mu,
        );
      }
    } finally {
      destroyFixture(fixture);
    }
  }
});

test("D-106 rollback rename 前重验可恢复原件，漂移时保留阻断现场", async () => {
  const fixture = createFixture();
  const stagingOriginal = resolve(
    fixture.root,
    "site-content",
    `.author-staging-${OWNER}`,
    "original",
  );
  try {
    await expectCode(
      () => setArticleDates({
        arguments_: commandArguments("publish"),
        dependencies: dependencies({
          async checkHistory() {
            throw new Error("force rollback");
          },
        }),
        environment: {},
        root: fixture.root,
        testHooks: {
          beforeRollbackReplace() {
            writeFileSync(stagingOriginal, "external staging mutation\n", "utf8");
          },
        },
      }),
      "AUTHOR_ROLLBACK",
    );
    assert.match(
      readFileSync(fixture.path, "utf8"),
      /^publishedAt: "2026-07-28"$/mu,
    );
    assert.equal(
      existsSync(resolve(fixture.root, ".axial-muse-author.lock")),
      true,
    );
    assert.equal(existsSync(stagingOriginal), true);
  } finally {
    destroyFixture(fixture);
  }
});

test("D-106 rollback 先持久化恢复目标，目录 flush 失败保留 operation-first 现场", async () => {
  const fixture = createFixture();
  const before = readFileSync(fixture.path);
  const stagingPath = resolve(
    fixture.root,
    "site-content",
    `.author-staging-${OWNER}`,
  );
  const operationError = new ContentHistoryError(
    "CONTENT_HISTORY_CURRENT_SCHEMA",
  );
  const rollbackError = new Error("synthetic rollback destination flush");
  const rollbackFlushes = [];
  let rollbackStarted = false;
  try {
    let caught;
    await assert.rejects(
      () => setArticleDates({
        arguments_: commandArguments("publish"),
        dependencies: dependencies({
          async checkHistory() {
            throw operationError;
          },
          flushDirectory(path) {
            if (!rollbackStarted) return;
            rollbackFlushes.push(path);
            if (path === dirname(fixture.path)) throw rollbackError;
          },
        }),
        environment: {},
        root: fixture.root,
        testHooks: {
          beforeRollback() {
            rollbackStarted = true;
          },
        },
      }),
      (error) => {
        caught = error;
        return error?.code === "AUTHOR_ROLLBACK";
      },
    );
    assert.ok(caught.cause instanceof AggregateError);
    assert.strictEqual(caught.cause.errors[0], operationError);
    assert.strictEqual(caught.cause.errors[1], rollbackError);
    assert.deepEqual(rollbackFlushes, [
      stagingPath,
      resolve(fixture.root, "site-content"),
      dirname(fixture.path),
    ]);
    assert.deepEqual(readFileSync(fixture.path), before);
    assert.equal(
      existsSync(resolve(fixture.root, ".axial-muse-author.lock")),
      true,
    );
    assert.equal(existsSync(stagingPath), true);
  } finally {
    destroyFixture(fixture);
  }
});

test("D-106 build 双锁竞态、双正文入口和 symlink 目标均失败关闭", async () => {
  const buildRace = createFixture();
  const buildLock = resolve(buildRace.root, ".axial-muse-build.lock");
  try {
    const before = readFileSync(buildRace.path);
    await expectCode(
      () => setArticleDates({
        arguments_: commandArguments("publish"),
        dependencies: dependencies(),
        environment: {},
        root: buildRace.root,
        testHooks: {
          afterLockAcquired() {
            writeFileSync(buildLock, "synthetic build\n", "utf8");
          },
        },
      }),
      "AUTHOR_BUILD_ACTIVE",
    );
    assert.deepEqual(readFileSync(buildRace.path), before);
    assert.equal(existsSync(buildLock), true);
    assert.deepEqual(residue(buildRace.root), {lock: false, staging: []});
  } finally {
    destroyFixture(buildRace);
  }

  const duplicate = createFixture();
  try {
    writeFileSync(
      resolve(
        duplicate.root,
        `site-content/writing/${SOURCE_NAME}/index.mdx`,
      ),
      articleSource({extension: "mdx"}).text,
      "utf8",
    );
    await expectCode(
      () => setArticleDates({
        arguments_: commandArguments("publish"),
        dependencies: dependencies(),
        environment: {},
        root: duplicate.root,
      }),
      "AUTHOR_DATE_TARGET",
    );
  } finally {
    destroyFixture(duplicate);
  }

  const linked = createFixture();
  try {
    const outside = resolve(linked.root, "outside.md");
    writeFileSync(outside, articleSource().text, "utf8");
    rmSync(linked.path);
    symlinkSync(outside, linked.path);
    await expectCode(
      () => setArticleDates({
        arguments_: commandArguments("publish"),
        dependencies: dependencies(),
        environment: {},
        root: linked.root,
      }),
      "AUTHOR_DATE_TARGET",
    );
    assert.equal(readFileSync(outside, "utf8"), articleSource().text);
  } finally {
    destroyFixture(linked);
  }
});

test("D-106 回滚所有权失效保留 lock/staging 并拒绝覆盖外部 target", async () => {
  const fixture = createFixture();
  try {
    await expectCode(
      () => setArticleDates({
        arguments_: commandArguments("publish"),
        dependencies: dependencies(),
        environment: {},
        root: fixture.root,
        testHooks: {
          afterSourceReplace() {
            writeFileSync(fixture.path, "external replacement\n", "utf8");
            throw new Error("force rollback after external replacement");
          },
        },
      }),
      "AUTHOR_ROLLBACK",
    );
    assert.equal(readFileSync(fixture.path, "utf8"), "external replacement\n");
    assert.equal(
      existsSync(resolve(fixture.root, ".axial-muse-author.lock")),
      true,
    );
    assert.deepEqual(
      readdirSync(resolve(fixture.root, "site-content"))
        .filter((name) => name.startsWith(".author-staging-")),
      [`${".author-staging-"}${OWNER}`],
    );
  } finally {
    destroyFixture(fixture);
  }
});

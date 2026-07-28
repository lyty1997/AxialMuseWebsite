import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, relative, resolve} from "node:path";
import test from "node:test";
import {
  ArticleCreateError,
  createArticle,
  parseCreateArticleArguments,
} from "../../scripts/author/create-article.mjs";
import {AUTHOR_STAGING_PREFIX} from "../../scripts/author/lib/transaction-state.mjs";
import {ContentHistoryError} from "../../scripts/quality/lib/content-history.mjs";
import "./run-create-article-tests.test.mjs";

const ARTICLE_ID = "018f0000-0000-7000-8000-000000000001";
const OWNER = "a".repeat(64);
const SOURCE_NAME = "transaction-fixture";
const SUMMARY = "这是一段用于作者命令事务测试并且长度足够的可信摘要。";
const ARGUMENTS = Object.freeze([
  "--source-name",
  SOURCE_NAME,
  "--title",
  "原子文章创建事务",
  "--slug",
  "/writing/independent-route",
  "--summary",
  SUMMARY,
  "--author",
  "example-author",
  "--author",
  "second-author",
  "--topic",
  "architecture",
  "--topic",
  "testing",
  "--project",
  "example-project",
  "--module",
  "core",
]);

function writeFixture(root, relativePath, contents) {
  const path = resolve(root, relativePath);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, contents);
}

function writeJson(root, relativePath, value) {
  writeFixture(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-create-article-"));
  writeFixture(root, ".nvmrc", `${process.versions.node}\n`);
  mkdirSync(resolve(root, "site-content/writing"), {recursive: true});
  writeJson(root, "docs/contracts/authors.json", {
    version: "0.1.0",
    kind: "axial_muse_authors",
    status: "active",
    owner: "AxialMuseWebsite",
    authors: {
      "example-author": {
        displayName: "Example Author",
      },
      "second-author": {
        displayName: "Second Author",
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
      testing: {
        displayName: "测试",
        navigationOrder: 20,
        status: "active",
      },
    },
  });
  writeJson(root, "docs/contracts/projects.json", {
    projects: [{
      id: "example-project",
      writingModules: [{
        id: "core",
      }],
    }],
  });
  return root;
}

function fixtureDependencies(overrides = {}) {
  return {
    async checkHistory() {},
    async checkHistoryCandidate() {},
    createOwner() {
      return OWNER;
    },
    createUuid() {
      return ARTICLE_ID;
    },
    ...overrides,
  };
}

function targetPath(root) {
  return resolve(root, "site-content/writing", SOURCE_NAME);
}

function assertNoOwnedResidue(root) {
  assert.equal(existsSync(resolve(root, ".axial-muse-author.lock")), false);
  assert.equal(existsSync(targetPath(root)), false);
  assert.deepEqual(
    readdirSync(resolve(root, "site-content"))
      .filter((name) => name.startsWith(".author-staging-")),
    [],
  );
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

test("CODE-014 参数解析保持显式顺序并拒绝任何隐式默认", () => {
  assert.deepEqual(parseCreateArticleArguments([...ARGUMENTS]), {
    sourceName: SOURCE_NAME,
    title: "原子文章创建事务",
    slug: "/writing/independent-route",
    summary: SUMMARY,
    authors: ["example-author", "second-author"],
    topics: ["architecture", "testing"],
    project: "example-project",
    module: "core",
  });

  const dashedTitle = "--以双连字符开头的合法文章标题";
  const dashedSummary = "--这是一段以双连字符开头并且长度足够的合法文章摘要。";
  const dashedTextArguments = ARGUMENTS.map((value) => {
    if (value === "原子文章创建事务") return dashedTitle;
    if (value === SUMMARY) return dashedSummary;
    return value;
  });
  const dashedText = parseCreateArticleArguments(dashedTextArguments);
  assert.equal(dashedText.title, dashedTitle);
  assert.equal(dashedText.summary, dashedSummary);

  for (const arguments_ of [
    ARGUMENTS.slice(2),
    [...ARGUMENTS, "position"],
    ARGUMENTS.map((value) => (
      value === "--slug" ? "--slug=/writing/independent-route" : value
    )),
    [...ARGUMENTS, "--title", "重复标题"],
    ARGUMENTS.filter((value) => value !== "--topic" && value !== "architecture"),
    [...ARGUMENTS, "--topic", "architecture"],
    ARGUMENTS.map((value) => (
      value === SOURCE_NAME ? "Transaction-Fixture" : value
    )),
    ARGUMENTS.map((value) => (
      value === "原子文章创建事务" ? " 原子文章创建事务" : value
    )),
    [...ARGUMENTS, "--author", "third-author", "--author", "fourth-author", "--author", "fifth-author"],
    [...ARGUMENTS, "--topic", "third-topic", "--topic", "fourth-topic", "--topic", "fifth-topic", "--topic", "sixth-topic"],
  ]) {
    assert.throws(
      () => parseCreateArticleArguments(arguments_),
      (error) => error instanceof ArticleCreateError
      && error.code === "AUTHOR_ARGUMENTS",
    );
  }

  assert.deepEqual(
    parseCreateArticleArguments([
      ...ARGUMENTS,
      "--author",
      "third-author",
      "--author",
      "fourth-author",
      "--topic",
      "third-topic",
      "--topic",
      "fourth-topic",
      "--topic",
      "fifth-topic",
    ]).authors,
    ["example-author", "second-author", "third-author", "fourth-author"],
  );
  const moduleWithoutProject = [...ARGUMENTS];
  moduleWithoutProject.splice(moduleWithoutProject.indexOf("--project"), 2);
  assert.throws(
    () => parseCreateArticleArguments(moduleWithoutProject),
    (error) => error instanceof ArticleCreateError
      && error.code === "AUTHOR_REFERENCE",
  );
});

test("CODE-014 成功只提交完整 draft 目录并保持字段输入顺序", async () => {
  const root = createFixture();
  try {
    const result = await createArticle({
      arguments_: [...ARGUMENTS],
      dependencies: fixtureDependencies(),
      root,
    });
    assert.deepEqual(result, {
      articleId: ARTICLE_ID,
      sourcePath: `site-content/writing/${SOURCE_NAME}/index.md`,
    });
    assert.equal(existsSync(resolve(root, ".axial-muse-author.lock")), false);
    assert.deepEqual(readdirSync(targetPath(root)), ["index.md"]);
    const source = readFileSync(resolve(targetPath(root), "index.md"), "utf8");
    assert.match(source, new RegExp(`^---\\narticleId: "${ARTICLE_ID}"\\n`, "u"));
    assert.match(source, /publicationStatus: "draft"\nauthors:\n  - "example-author"\n  - "second-author"\nclassification:\n  project: "example-project"\n  module: "core"\n  topics:\n    - "architecture"\n    - "testing"\n---\n/u);
    assert.doesNotMatch(source, /publishedAt|updatedAt/u);
    for (const heading of [
      "问题背景",
      "约束与非目标",
      "方案选择",
      "实现或实验",
      "验证结果",
      "复盘",
      "参考来源",
    ]) {
      assert.match(source, new RegExp(`^## ${heading}$`, "mu"));
    }
    assert.deepEqual(
      readdirSync(resolve(root, "site-content"))
        .filter((name) => name.startsWith(".author-staging-")),
      [],
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("CODE-014 未知注册表 ID 和既有目标在加锁前失败且不改既有字节", async () => {
  const unknown = createFixture();
  try {
    const arguments_ = [...ARGUMENTS];
    arguments_[arguments_.indexOf("architecture")] = "unknown-topic";
    await expectCode(
      () => createArticle({
        arguments_,
        dependencies: fixtureDependencies(),
        root: unknown,
      }),
      "AUTHOR_REFERENCE",
    );
    assertNoOwnedResidue(unknown);
  } finally {
    rmSync(unknown, {recursive: true, force: true});
  }

  for (const kind of ["file", "symlink", "empty-directory", "directory"]) {
    const existing = createFixture();
    const target = targetPath(existing);
    try {
      if (kind === "file") writeFixture(existing, `site-content/writing/${SOURCE_NAME}`, "existing\n");
      if (kind === "symlink") symlinkSync("../outside-target", target);
      if (kind === "empty-directory") mkdirSync(target);
      if (kind === "directory") {
        writeFixture(existing, `site-content/writing/${SOURCE_NAME}/sentinel.txt`, "existing\n");
      }
      await expectCode(
        () => createArticle({
          arguments_: [...ARGUMENTS],
          dependencies: fixtureDependencies(),
          root: existing,
        }),
        "AUTHOR_TARGET_EXISTS",
      );
      if (kind === "file") assert.equal(readFileSync(target, "utf8"), "existing\n");
      if (kind === "symlink") assert.equal(readlinkSync(target), "../outside-target");
      if (kind === "empty-directory") {
        assert.equal(lstatSync(target).isDirectory(), true);
        assert.deepEqual(readdirSync(target), []);
      }
      if (kind === "directory") {
        assert.equal(
          readFileSync(resolve(target, "sentinel.txt"), "utf8"),
          "existing\n",
        );
      }
      assert.equal(existsSync(resolve(existing, ".axial-muse-author.lock")), false);
    } finally {
      rmSync(existing, {recursive: true, force: true});
    }
  }
});

test("CODE-014 已有 lock 或任意 staging residue 都不由创建命令猜测回收", async () => {
  for (const residue of [
    ".axial-muse-author.lock",
    "site-content/.author-staging-unknown",
  ]) {
    const root = createFixture();
    try {
      writeFixture(root, residue, "preexisting\n");
      await expectCode(
        () => createArticle({
          arguments_: [...ARGUMENTS],
          dependencies: fixtureDependencies(),
          root,
        }),
        "AUTHOR_TRANSACTION_RESIDUE",
      );
      assert.equal(readFileSync(resolve(root, residue), "utf8"), "preexisting\n");
      assert.equal(existsSync(targetPath(root)), false);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  }
});

test("CODE-014 production build lock 在加作者锁前后均阻断创建且不被回收", async () => {
  for (const phase of ["preflight", "locked"]) {
    const root = createFixture();
    const buildLock = resolve(root, ".axial-muse-build.lock");
    try {
      if (phase === "preflight") writeFileSync(buildLock, "build\n");
      await expectCode(
        () => createArticle({
          arguments_: [...ARGUMENTS],
          dependencies: fixtureDependencies(),
          root,
          ...(phase === "locked"
            ? {
              testHooks: {
                afterLockAcquired() {
                  writeFileSync(buildLock, "build\n");
                },
              },
            }
            : {}),
        }),
        "AUTHOR_BUILD_ACTIVE",
      );
      assert.equal(readFileSync(buildLock, "utf8"), "build\n");
      assert.equal(
        existsSync(resolve(root, ".axial-muse-author.lock")),
        false,
      );
      assert.equal(existsSync(targetPath(root)), false);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  }
});

test("CODE-014 preflight 后的 lock 竞争者不被 O_EXCL 覆盖或回收", async () => {
  const root = createFixture();
  const lockPath = resolve(root, ".axial-muse-author.lock");
  try {
    await expectCode(
      () => createArticle({
        arguments_: [...ARGUMENTS],
        dependencies: fixtureDependencies({
          createOwner() {
            writeFileSync(lockPath, "competitor\n", "utf8");
            return OWNER;
          },
        }),
        root,
      }),
      "AUTHOR_LOCK",
    );
    assert.equal(readFileSync(lockPath, "utf8"), "competitor\n");
    assert.equal(existsSync(targetPath(root)), false);
    assert.deepEqual(
      readdirSync(resolve(root, "site-content"))
        .filter((name) => name.startsWith(".author-staging-")),
      [],
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("CODE-014 两个并发创建只有持锁者可进入历史候选与写入", async () => {
  const root = createFixture();
  let enterCandidate;
  let releaseCandidate;
  const candidateEntered = new Promise((resolveEntered) => {
    enterCandidate = resolveEntered;
  });
  const candidateRelease = new Promise((resolveRelease) => {
    releaseCandidate = resolveRelease;
  });
  let first;
  try {
    first = createArticle({
      arguments_: [...ARGUMENTS],
      dependencies: fixtureDependencies({
        async checkHistoryCandidate() {
          enterCandidate();
          await candidateRelease;
        },
      }),
      root,
    });
    await candidateEntered;
    await expectCode(
      () => createArticle({
        arguments_: [...ARGUMENTS],
        dependencies: fixtureDependencies(),
        root,
      }),
      "AUTHOR_TRANSACTION_RESIDUE",
    );
    releaseCandidate();
    await first;
    assert.deepEqual(readdirSync(targetPath(root)), ["index.md"]);
    assert.equal(
      existsSync(resolve(root, ".axial-muse-author.lock")),
      false,
    );
  } finally {
    releaseCandidate?.();
    await first?.catch(() => {});
    rmSync(root, {recursive: true, force: true});
  }
});

test("CODE-014 历史候选失败发生在 staging 前并保留原历史错误码", async () => {
  const root = createFixture();
  try {
    let candidateCalls = 0;
    await expectCode(
      () => createArticle({
        arguments_: [...ARGUMENTS],
        dependencies: fixtureDependencies({
          async checkHistoryCandidate(candidate) {
            candidateCalls += 1;
            assert.deepEqual(candidate, {
              articleId: ARTICLE_ID,
              sourceName: SOURCE_NAME,
            });
            assert.equal(
              existsSync(resolve(root, ".axial-muse-author.lock")),
              true,
            );
            assert.equal(existsSync(targetPath(root)), false);
            assert.deepEqual(
              readdirSync(resolve(root, "site-content"))
                .filter((name) => name.startsWith(".author-staging-")),
              [],
            );
            throw new ContentHistoryError(
              "CONTENT_HISTORY_SOURCE_REUSED",
              {
                commit: "WORKTREE",
                sourcePath: `site-content/writing/${SOURCE_NAME}`,
              },
            );
          },
        }),
        root,
      }),
      "CONTENT_HISTORY_SOURCE_REUSED",
    );
    assert.equal(candidateCalls, 1);
    assertNoOwnedResidue(root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("CODE-014 注册表在锁内漂移时不写 staging，也不回滚外部编辑", async () => {
  const root = createFixture();
  try {
    await expectCode(
      () => createArticle({
        arguments_: [...ARGUMENTS],
        dependencies: fixtureDependencies(),
        root,
        testHooks: {
          afterLockAcquired() {
            writeJson(root, "docs/contracts/authors.json", {
              changedByFixture: true,
            });
          },
        },
      }),
      "AUTHOR_REGISTRY_DRIFT",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(resolve(root, "docs/contracts/authors.json"), "utf8")),
      {changedByFixture: true},
    );
    assertNoOwnedResidue(root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("CODE-014 rename 紧前出现目标时保留竞争者字节并只清理本事务", async () => {
  const root = createFixture();
  try {
    await expectCode(
      () => createArticle({
        arguments_: [...ARGUMENTS],
        dependencies: fixtureDependencies(),
        root,
        testHooks: {
          beforeTargetRename() {
            writeFixture(
              root,
              `site-content/writing/${SOURCE_NAME}/sentinel.txt`,
              "concurrent\n",
            );
          },
        },
      }),
      "AUTHOR_TARGET_EXISTS",
    );
    assert.equal(
      readFileSync(resolve(targetPath(root), "sentinel.txt"), "utf8"),
      "concurrent\n",
    );
    assert.equal(existsSync(resolve(root, ".axial-muse-author.lock")), false);
    assert.deepEqual(
      readdirSync(resolve(root, "site-content"))
        .filter((name) => name.startsWith(".author-staging-")),
      [],
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("CODE-014 正常路径实际调用 write、file flush、双目录 flush 与 rename adapter", async () => {
  const root = createFixture();
  const calls = [];
  try {
    await createArticle({
      arguments_: [...ARGUMENTS],
      dependencies: fixtureDependencies({
        flushDirectory(path) {
          calls.push(`directory-flush:${relative(root, path)}`);
        },
        flushFile() {
          calls.push("file-flush");
        },
        renameDirectory(source, target) {
          calls.push(
            `rename:${relative(root, source)}->${relative(root, target)}`,
          );
          renameSync(source, target);
        },
        releaseLockBoundary() {
          calls.push("lock-release-boundary");
        },
        writeArticle(descriptor, fileContent) {
          calls.push("write");
          writeFileSync(descriptor, fileContent, {encoding: "utf8"});
        },
      }),
      root,
    });
    assert.deepEqual(calls, [
      "write",
      "file-flush",
      `directory-flush:site-content/.author-staging-${OWNER}`,
      `rename:site-content/.author-staging-${OWNER}->site-content/writing/${SOURCE_NAME}`,
      "directory-flush:site-content/writing",
      "directory-flush:site-content",
      "lock-release-boundary",
    ]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("CODE-014 实际 I/O adapter 故障均恢复零部分目标", async (t) => {
  const cases = [
    {
      code: "AUTHOR_WRITE",
      overrides: {
        writeArticle() {
          throw new Error("fixture write syscall");
        },
      },
      title: "write",
    },
    {
      code: "AUTHOR_WRITE",
      overrides: {
        writeArticle(descriptor, fileContent) {
          writeFileSync(
            descriptor,
            fileContent.slice(0, 32),
            {encoding: "utf8"},
          );
          throw new Error("fixture partial write syscall");
        },
      },
      title: "partial-write",
    },
    {
      code: "AUTHOR_FILE_FLUSH",
      overrides: {
        flushFile() {
          throw new Error("fixture file fsync syscall");
        },
      },
      title: "file-flush",
    },
    {
      code: "AUTHOR_DIRECTORY_FLUSH",
      overrides: {
        flushDirectory(path) {
          if (path.endsWith(`${AUTHOR_STAGING_PREFIX}${OWNER}`)) {
            throw new Error("fixture staging fsync syscall");
          }
        },
      },
      title: "staging-directory-flush",
    },
    {
      code: "AUTHOR_RENAME",
      overrides: {
        renameDirectory() {
          throw new Error("fixture rename syscall");
        },
      },
      title: "rename",
    },
    {
      code: "AUTHOR_DIRECTORY_FLUSH",
      overrides: (() => {
        let failed = false;
        return {
          flushDirectory(path) {
            if (!failed && path.endsWith("site-content/writing")) {
              failed = true;
              throw new Error("fixture writing fsync syscall");
            }
          },
        };
      })(),
      title: "writing-directory-flush",
    },
    {
      code: "AUTHOR_DIRECTORY_FLUSH",
      overrides: (() => {
        let failed = false;
        return {
          flushDirectory(path) {
            if (!failed && path.endsWith("site-content")) {
              failed = true;
              throw new Error("fixture content fsync syscall");
            }
          },
        };
      })(),
      title: "content-directory-flush",
    },
    {
      code: "AUTHOR_LOCK_RELEASE",
      overrides: (() => {
        let failed = false;
        return {
          releaseLockBoundary() {
            if (!failed) {
              failed = true;
              throw new Error("fixture lock unlink syscall");
            }
          },
        };
      })(),
      title: "lock-release",
    },
  ];
  for (const {code, overrides, title} of cases) {
    await t.test(title, async () => {
      const root = createFixture();
      try {
        await expectCode(
          () => createArticle({
            arguments_: [...ARGUMENTS],
            dependencies: fixtureDependencies(overrides),
            root,
          }),
          code,
        );
        assertNoOwnedResidue(root);
      } finally {
        rmSync(root, {recursive: true, force: true});
      }
    });
  }
});

test("CODE-014 write/flush/rename/终态/commit 故障均恢复零部分目标", async (t) => {
  const cases = [
    ["beforeArticleWrite", "AUTHOR_WRITE"],
    ["beforeFileFlush", "AUTHOR_FILE_FLUSH"],
    ["beforeStagingDirectoryFlush", "AUTHOR_DIRECTORY_FLUSH"],
    ["beforeTargetRename", "AUTHOR_RENAME"],
    ["afterTargetRename", "AUTHOR_CONTENT"],
    ["beforeWritingDirectoryFlush", "AUTHOR_DIRECTORY_FLUSH"],
    ["beforeFinalHistoryCheck", "AUTHOR_CONTENT"],
  ];
  for (const [hookName, code] of cases) {
    await t.test(hookName, async () => {
      const root = createFixture();
      try {
        await expectCode(
          () => createArticle({
            arguments_: [...ARGUMENTS],
            dependencies: fixtureDependencies(),
            root,
            testHooks: {
              [hookName]() {
                throw new Error(`fixture ${hookName}`);
              },
            },
          }),
          code,
        );
        assertNoOwnedResidue(root);
      } finally {
        rmSync(root, {recursive: true, force: true});
      }
    });
  }
});

test("CODE-014 回滚所有权失效时保留 lock 阻断消费者并报告 AUTHOR_ROLLBACK", async () => {
  const root = createFixture();
  const operationError = new ContentHistoryError(
    "CONTENT_HISTORY_CURRENT_SCHEMA",
    {
      commit: "WORKTREE",
      sourcePath: `site-content/writing/${SOURCE_NAME}/index.md`,
    },
  );
  const rollbackError = new Error("fixture rollback ownership failure");
  try {
    await assert.rejects(
      () => createArticle({
        arguments_: [...ARGUMENTS],
        dependencies: fixtureDependencies({
          async checkHistory() {
            throw operationError;
          },
        }),
        root,
        testHooks: {
          beforeRollback() {
            throw rollbackError;
          },
        },
      }),
      (error) => {
        assert.equal(error?.code, "AUTHOR_ROLLBACK");
        assert.ok(error.cause instanceof AggregateError);
        assert.equal(error.cause.errors.length, 2);
        assert.strictEqual(error.cause.errors[0], operationError);
        assert.strictEqual(error.cause.errors[1], rollbackError);
        return true;
      },
    );
    assert.equal(existsSync(resolve(root, ".axial-muse-author.lock")), true);
    assert.deepEqual(readdirSync(targetPath(root)), ["index.md"]);
    assert.deepEqual(
      readdirSync(resolve(root, "site-content"))
        .filter((name) => name.startsWith(".author-staging-")),
      [],
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("CODE-014 激活后的真实历史失败保留 code 并回滚目标", async () => {
  const root = createFixture();
  try {
    let historyCalls = 0;
    await expectCode(
      () => createArticle({
        arguments_: [...ARGUMENTS],
        dependencies: fixtureDependencies({
          async checkHistory() {
            historyCalls += 1;
            assert.equal(
              existsSync(resolve(root, ".axial-muse-author.lock")),
              true,
            );
            assert.deepEqual(readdirSync(targetPath(root)), ["index.md"]);
            assert.deepEqual(
              readdirSync(resolve(root, "site-content"))
                .filter((name) => name.startsWith(".author-staging-")),
              [],
            );
            throw new ContentHistoryError(
              "CONTENT_HISTORY_CURRENT_SCHEMA",
              {
                commit: "WORKTREE",
                sourcePath: `site-content/writing/${SOURCE_NAME}/index.md`,
              },
            );
          },
        }),
        root,
      }),
      "CONTENT_HISTORY_CURRENT_SCHEMA",
    );
    assert.equal(historyCalls, 1);
    assertNoOwnedResidue(root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

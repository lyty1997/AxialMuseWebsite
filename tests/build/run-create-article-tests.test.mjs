import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import test from "node:test";
import {runCreateArticleTests} from "../../scripts/author/run-create-article-tests.mjs";

const TEST_FILES = Object.freeze([
  "tests/build/create-article.test.mjs",
  "tests/build/create-article.integration.test.mjs",
]);

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-author-runner-"));
  writeFileSync(resolve(root, ".nvmrc"), `${process.versions.node}\n`, "utf8");
  return root;
}

function silentReports() {
  const errors = [];
  const successes = [];
  return {
    errors,
    successes,
    reportError(message) {
      errors.push(message);
    },
    reportSuccess(message) {
      successes.push(message);
    },
  };
}

test("CODE-014 作者验收 runner 在精确 Linux 主端点按固定顺序运行两个 suite", () => {
  const root = createFixture();
  const calls = [];
  const reports = silentReports();
  try {
    const status = runCreateArticleTests({
      arguments_: [],
      environmentSource: {
        HOME: "/tmp/author-runner-home",
        LANG: "C.UTF-8",
        NODE_DEBUG: "child_process",
        NODE_OPTIONS: "--import=/tmp/fixture.mjs",
        PATH: "/usr/bin:/bin",
        SYNTHETIC_SECRET: "must-not-reach-child",
      },
      nodeVersion: process.versions.node,
      platform: "linux",
      reportError: reports.reportError,
      reportSuccess: reports.reportSuccess,
      root,
      spawnProcess(command, arguments_, options) {
        calls.push({arguments_, command, options});
        return {error: undefined, signal: null, status: 0};
      },
    });

    assert.equal(status, 0);
    assert.deepEqual(
      calls.map((call) => call.arguments_),
      TEST_FILES.map((sourcePath) => ["--test", resolve(root, sourcePath)]),
    );
    assert.deepEqual(
      calls.map((call) => call.command),
      [process.execPath, process.execPath],
    );
    for (const call of calls) {
      assert.equal(call.options.cwd, root);
      assert.equal(call.options.stdio, "inherit");
      assert.deepEqual(call.options.env, {
        HOME: "/tmp/author-runner-home",
        LANG: "C.UTF-8",
        PATH: "/usr/bin:/bin",
      });
    }
    assert.deepEqual(reports.errors, []);
    assert.deepEqual(reports.successes, ["Author create-article tests passed."]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("CODE-014 作者验收 runner 拒绝参数、非 Linux 与非精确 Node", () => {
  const root = createFixture();
  try {
    for (const options of [
      {arguments_: ["unexpected"], platform: "linux", nodeVersion: process.versions.node},
      {arguments_: [], platform: "darwin", nodeVersion: process.versions.node},
      {arguments_: [], platform: "linux", nodeVersion: "0.0.0"},
    ]) {
      const reports = silentReports();
      let spawnCalls = 0;
      assert.equal(
        runCreateArticleTests({
          ...options,
          reportError: reports.reportError,
          reportSuccess: reports.reportSuccess,
          root,
          spawnProcess() {
            spawnCalls += 1;
            return {error: undefined, signal: null, status: 0};
          },
        }),
        1,
      );
      assert.equal(spawnCalls, 0);
      assert.equal(reports.errors.length, 1);
      assert.deepEqual(reports.successes, []);
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("CODE-014 作者验收 runner 对 spawn error/status/signal 首错即停", () => {
  const failures = [
    {error: new Error("fixture spawn error"), signal: null, status: 0},
    {error: undefined, signal: null, status: 1},
    {error: undefined, signal: "SIGTERM", status: 0},
  ];
  for (const failure of failures) {
    const root = createFixture();
    const reports = silentReports();
    let spawnCalls = 0;
    try {
      assert.equal(
        runCreateArticleTests({
          arguments_: [],
          nodeVersion: process.versions.node,
          platform: "linux",
          reportError: reports.reportError,
          reportSuccess: reports.reportSuccess,
          root,
          spawnProcess() {
            spawnCalls += 1;
            return failure;
          },
        }),
        1,
      );
      assert.equal(spawnCalls, 1);
      assert.deepEqual(reports.successes, []);
      assert.deepEqual(reports.errors, [
        `[AUTHOR_TEST] 作者命令验收失败；source=${TEST_FILES[0]}`,
      ]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  }
});

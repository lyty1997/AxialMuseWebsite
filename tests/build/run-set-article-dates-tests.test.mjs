import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import test from "node:test";
import {
  runSetArticleDatesTests,
} from "../../scripts/author/run-set-article-dates-tests.mjs";

const TEST_FILES = Object.freeze([
  "tests/build/article-date-edit.test.mjs",
  "tests/build/set-article-dates.test.mjs",
  "tests/build/set-article-dates.integration.test.mjs",
]);

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-date-runner-"));
  writeFileSync(resolve(root, ".nvmrc"), `${process.versions.node}\n`, "utf8");
  return root;
}

function reports() {
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

test("D-106 日期验收 runner 在主端点按固定顺序隔离运行三个 suite", () => {
  const root = createFixture();
  const calls = [];
  const output = reports();
  try {
    const status = runSetArticleDatesTests({
      arguments_: [],
      environmentSource: {
        HOME: "/tmp/date-runner-home",
        LANG: "C.UTF-8",
        NODE_DEBUG: "child_process",
        PATH: "/usr/bin:/bin",
        SYNTHETIC_SECRET: "must-not-reach-child",
      },
      nodeVersion: process.versions.node,
      platform: "linux",
      reportError: output.reportError,
      reportSuccess: output.reportSuccess,
      root,
      spawnProcess(command, arguments_, options) {
        calls.push({arguments_, command, options});
        return {error: undefined, signal: null, status: 0};
      },
    });
    assert.equal(status, 0);
    assert.deepEqual(
      calls.map((call) => call.arguments_),
      TEST_FILES.map((sourcePath) => [
        "--test",
        resolve(root, sourcePath),
      ]),
    );
    for (const call of calls) {
      assert.equal(call.command, process.execPath);
      assert.equal(call.options.cwd, root);
      assert.equal(call.options.stdio, "inherit");
      assert.deepEqual(call.options.env, {
        HOME: "/tmp/date-runner-home",
        LANG: "C.UTF-8",
        PATH: "/usr/bin:/bin",
      });
    }
    assert.deepEqual(output.errors, []);
    assert.deepEqual(output.successes, [
      "Author set-article-dates tests passed.",
    ]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("D-106 日期验收 runner 拒绝 CI 与 GitHub runner 间接调用", () => {
  const root = createFixture();
  try {
    for (const key of [
      "CI",
      "GITHUB_ACTIONS",
      "GITHUB_JOB",
      "GITHUB_WORKFLOW",
      "RUNNER_OS",
    ]) {
      const output = reports();
      let spawnCalls = 0;
      assert.equal(
        runSetArticleDatesTests({
          arguments_: [],
          environmentSource: {[key]: "true"},
          nodeVersion: process.versions.node,
          platform: "linux",
          reportError: output.reportError,
          reportSuccess: output.reportSuccess,
          root,
          spawnProcess() {
            spawnCalls += 1;
            return {error: undefined, signal: null, status: 0};
          },
        }),
        1,
      );
      assert.equal(spawnCalls, 0);
      assert.deepEqual(output.successes, []);
      assert.deepEqual(output.errors, [
        "[AUTHOR_DATE_TEST] 作者日期验收入口不得由自动化环境触发。",
      ]);
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("D-106 日期验收 runner 拒绝参数、非 Linux 与非精确 Node", () => {
  const root = createFixture();
  try {
    for (const options of [
      {
        arguments_: ["unexpected"],
        nodeVersion: process.versions.node,
        platform: "linux",
      },
      {
        arguments_: [],
        nodeVersion: process.versions.node,
        platform: "darwin",
      },
      {
        arguments_: [],
        nodeVersion: "0.0.0",
        platform: "linux",
      },
    ]) {
      const output = reports();
      let spawnCalls = 0;
      assert.equal(
        runSetArticleDatesTests({
          ...options,
          reportError: output.reportError,
          reportSuccess: output.reportSuccess,
          root,
          spawnProcess() {
            spawnCalls += 1;
            return {error: undefined, signal: null, status: 0};
          },
        }),
        1,
      );
      assert.equal(spawnCalls, 0);
      assert.equal(output.errors.length, 1);
      assert.deepEqual(output.successes, []);
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("D-106 日期验收 runner 对 spawn error/status/signal 首错即停", () => {
  for (const failure of [
    {error: new Error("fixture spawn error"), signal: null, status: 0},
    {error: undefined, signal: null, status: 1},
    {error: undefined, signal: "SIGTERM", status: 0},
  ]) {
    const root = createFixture();
    const output = reports();
    let spawnCalls = 0;
    try {
      assert.equal(
        runSetArticleDatesTests({
          arguments_: [],
          nodeVersion: process.versions.node,
          platform: "linux",
          reportError: output.reportError,
          reportSuccess: output.reportSuccess,
          root,
          spawnProcess() {
            spawnCalls += 1;
            return failure;
          },
        }),
        1,
      );
      assert.equal(spawnCalls, 1);
      assert.deepEqual(output.successes, []);
      assert.deepEqual(output.errors, [
        `[AUTHOR_DATE_TEST] 作者日期验收失败；source=${TEST_FILES[0]}`,
      ]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  }
});

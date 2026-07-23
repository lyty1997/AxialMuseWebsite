import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {
  assertSupportedTestNodeVersion,
  assertTestWorkspace,
  parseTestArguments,
  resolveTypeScriptCli,
  runTests,
  TestRunError,
} from "../../scripts/quality/run-tests.mjs";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

function writeFixture(root, relativePath, contents) {
  const path = resolve(root, relativePath);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, contents, "utf8");
}

function fakeCompilerSource(behavior) {
  return `
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

const behavior = ${JSON.stringify(behavior)};
const outputIndex = process.argv.indexOf("--outDir");
if (outputIndex === -1 || outputIndex + 1 >= process.argv.length) {
  process.stderr.write("missing outDir\\n");
  process.exit(9);
}
if (behavior === "compile-failure") {
  process.stderr.write("tests/build/example.test.ts(1,1): error TS9999: synthetic compile failure\\n");
  process.exitCode = 2;
} else {
  const outputRoot = process.argv[outputIndex + 1];
  const buildRoot = resolve(outputRoot, "tests/build");
  mkdirSync(buildRoot, {recursive: true});
  writeFileSync(resolve(buildRoot, "support.js"), "export const fixtureValue = 42;\\n", "utf8");
  let testBody;
  if (behavior === "test-failure") {
    testBody = 'import test from "node:test";\\ntest("E-012 synthetic failing test", () => { throw new Error("synthetic execution failure"); });\\n';
  } else if (behavior === "decoder-runtime") {
    testBody = 'import assert from "node:assert/strict";\\nimport {readFileSync, readdirSync} from "node:fs";\\nimport test from "node:test";\\nimport {frontMatterDecoderFixture} from "../../scripts/content/frontmatter.mjs";\\nimport {jsonDecoderFixture} from "../../scripts/content/json.mjs";\\ntest("E-012 copied decoder runtime", () => { const runtimeRoot = new URL("../../scripts/content/", import.meta.url); assert.equal(frontMatterDecoderFixture, "frontmatter-runtime"); assert.equal(jsonDecoderFixture, "json-runtime"); assert.deepEqual(readdirSync(runtimeRoot).sort(), ["frontmatter.d.mts", "frontmatter.mjs", "json.d.mts", "json.mjs"]); assert.equal(readFileSync(new URL("frontmatter.d.mts", runtimeRoot), "utf8"), "export declare const frontMatterDecoderFixture: string;\\\\n"); assert.equal(readFileSync(new URL("json.d.mts", runtimeRoot), "utf8"), "export declare const jsonDecoderFixture: string;\\\\n"); });\\n';
  } else if (behavior === "decoder-near-match") {
    testBody = 'import assert from "node:assert/strict";\\nimport {existsSync} from "node:fs";\\nimport test from "node:test";\\ntest("E-012 near-match does not copy decoder runtime", () => { assert.equal(existsSync(new URL("../../scripts/content/", import.meta.url)), false); });\\n';
  } else {
    testBody = 'import assert from "node:assert/strict";\\nimport {readFileSync} from "node:fs";\\nimport test from "node:test";\\nimport {fixtureValue} from "./support.js";\\ntest("E-012 fake legal .js import", () => { assert.equal(fixtureValue, 42); assert.deepEqual(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")), {type: "module", private: true}); });\\n';
  }
  writeFileSync(resolve(buildRoot, "example.test.js"), testBody, "utf8");
  if (behavior === "decoder-runtime" || behavior === "decoder-near-match") {
    const adapterRoot = resolve(outputRoot, "src/build/content");
    mkdirSync(adapterRoot, {recursive: true});
    const adapterName = behavior === "decoder-runtime"
      ? "content-decoders.js"
      : "content-decoders-copy.js";
    writeFileSync(resolve(adapterRoot, adapterName), "export const emittedAdapter = true;\\n", "utf8");
  }
  if (behavior === "extra-emit") {
    const domainRoot = resolve(outputRoot, "tests/domain");
    mkdirSync(domainRoot, {recursive: true});
    writeFileSync(resolve(domainRoot, "extra.test.js"), 'import test from "node:test";\\ntest("extra", () => {});\\n', "utf8");
  }
}
`;
}

function createFixture({behavior = "success", withSource = true} = {}) {
  const outer = mkdtempSync(join(tmpdir(), "axial-muse-run-tests-fixture-"));
  const root = resolve(outer, "project");
  const temporaryParent = resolve(outer, "outputs");
  mkdirSync(resolve(root, "tests/domain"), {recursive: true});
  mkdirSync(resolve(root, "tests/build"), {recursive: true});
  mkdirSync(temporaryParent);
  writeFixture(root, "tests/tsconfig.json", "{}\n");
  if (withSource) {
    writeFixture(
      root,
      "tests/build/example.test.ts",
      "import {fixtureValue} from \"./support.js\";\nvoid fixtureValue;\n",
    );
  }
  writeFixture(
    root,
    "scripts/content/frontmatter.mjs",
    'export const frontMatterDecoderFixture = "frontmatter-runtime";\n',
  );
  writeFixture(
    root,
    "scripts/content/frontmatter.d.mts",
    "export declare const frontMatterDecoderFixture: string;\n",
  );
  writeFixture(
    root,
    "scripts/content/json.mjs",
    'export const jsonDecoderFixture = "json-runtime";\n',
  );
  writeFixture(
    root,
    "scripts/content/json.d.mts",
    "export declare const jsonDecoderFixture: string;\n",
  );
  const compilerPath = resolve(outer, "fake-tsc.mjs");
  writeFileSync(compilerPath, fakeCompilerSource(behavior), "utf8");
  return {outer, root, temporaryParent, compilerPath};
}

function destroyFixture(fixture) {
  rmSync(fixture.outer, {recursive: true, force: true});
}

function captureRun(fixture, overrides = {}) {
  let stdout = "";
  let stderr = "";
  const calls = [];
  let result;
  let error;
  try {
    result = runTests({
      root: fixture.root,
      cwd: fixture.root,
      nodeVersion: "24.18.0",
      temporaryParent: fixture.temporaryParent,
      assertRuntime: () => "primary",
      validateProgram: () => ({files: [], issues: []}),
      resolveCompiler: () => fixture.compilerPath,
      spawnProcess(executable, arguments_, options) {
        calls.push({executable, arguments_: [...arguments_], options});
        return spawnSync(executable, arguments_, options);
      },
      standardOutput: {write(value) { stdout += value; }},
      standardError: {write(value) { stderr += value; }},
      ...overrides,
    });
  } catch (caught) {
    error = caught;
  }
  return {calls, error, result, stderr, stdout};
}

function hasTestCode(code) {
  return (error) => error instanceof TestRunError && error.code === code;
}

function assertTemporaryParentEmpty(fixture) {
  assert.deepEqual(readdirSync(fixture.temporaryParent), []);
}

function createCompilerFixture() {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-test-compiler-fixture-"));
  const compilerPath = resolve(root, "node_modules/typescript/bin/tsc");
  writeFixture(root, "node_modules/typescript/bin/tsc", "#!/usr/bin/env node\n");
  chmodSync(compilerPath, 0o775);
  writeFixture(root, "node_modules/typescript/package.json", '{"version":"6.0.2"}\n');
  writeFixture(
    root,
    "package-lock.json",
    '{"packages":{"node_modules/typescript":{"version":"6.0.2"}}}\n',
  );
  return {compilerPath, root};
}

test("E-012 测试入口参数、工作区与主/最低 Node 端点封闭", () => {
  assert.deepEqual(parseTestArguments([]), {});
  assert.throws(() => parseTestArguments(["fixture"]), hasTestCode("TEST_ARGUMENTS"));
  assert.equal(
    assertSupportedTestNodeVersion({root: PROJECT_ROOT, nodeVersion: "24.18.0"}),
    "primary",
  );
  assert.equal(
    assertSupportedTestNodeVersion({root: PROJECT_ROOT, nodeVersion: "24.16.0"}),
    "minimum",
  );
  assert.throws(
    () => assertSupportedTestNodeVersion({root: PROJECT_ROOT, nodeVersion: "22.22.0"}),
    hasTestCode("TEST_RUNTIME_NODE"),
  );
  assert.throws(
    () => assertTestWorkspace({root: PROJECT_ROOT, cwd: resolve(PROJECT_ROOT, "tests")}),
    hasTestCode("TEST_WORKSPACE"),
  );
});

test("E-012 本地冻结 TypeScript CLI 接受 npm 组模式并拒绝身份漂移", () => {
  const fixture = createCompilerFixture();
  try {
    assert.equal(resolveTypeScriptCli({root: fixture.root}), fixture.compilerPath);

    const hardLink = resolve(fixture.root, "node_modules/typescript/bin/tsc-hardlink");
    linkSync(fixture.compilerPath, hardLink);
    assert.throws(
      () => resolveTypeScriptCli({root: fixture.root}),
      hasTestCode("TEST_DEPENDENCIES"),
    );
    rmSync(hardLink);

    chmodSync(fixture.compilerPath, 0o777);
    assert.throws(
      () => resolveTypeScriptCli({root: fixture.root}),
      hasTestCode("TEST_DEPENDENCIES"),
    );
    chmodSync(fixture.compilerPath, 0o775);

    writeFixture(
      fixture.root,
      "node_modules/typescript/package.json",
      '{"version":"6.0.3"}\n',
    );
    assert.throws(
      () => resolveTypeScriptCli({root: fixture.root}),
      hasTestCode("TEST_DEPENDENCIES"),
    );
  } finally {
    rmSync(fixture.root, {recursive: true, force: true});
  }
});

test("E-012 临时 emit 后以当前 Node 直接执行合法 .js 跨模块测试", () => {
  const fixture = createFixture();
  try {
    const captured = captureRun(fixture);
    assert.equal(captured.error, undefined, `${captured.stdout}\n${captured.stderr}`);
    assert.deepEqual(captured.result, {
      runtimeRole: "primary",
      sourceFiles: ["tests/build/example.test.ts"],
    });
    assert.equal(captured.calls.length, 2);
    assert.equal(captured.calls[0].executable, process.execPath);
    assert.deepEqual(captured.calls[0].arguments_.slice(0, 3), [
      fixture.compilerPath,
      "-p",
      resolve(fixture.root, "tests/tsconfig.json"),
    ]);
    assert.equal(captured.calls[0].arguments_[3], "--outDir");
    assert.equal(captured.calls[1].arguments_[0], "--test");
    assert.equal(
      captured.calls.flatMap((call) => call.arguments_)
        .some((argument) => /loader|experimental-specifier-resolution/u.test(argument)),
      false,
    );
    assert.match(captured.stdout, /E-012 fake legal \.js import/u);
    assert.match(captured.stdout, /tests\/build\/example\.test\.ts/u);
    assert.equal(captured.stderr, "");
    assertTemporaryParentEmpty(fixture);
    assert.equal(existsSync(resolve(fixture.root, "tests/build/example.test.js")), false);
    assert.equal(existsSync(resolve(fixture.root, "build")), false);
    assert.equal(existsSync(resolve(fixture.root, "dist")), false);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-012 精确 emitted decoder importer 触发固定四文件复制与字节复核", () => {
  const fixture = createFixture({behavior: "decoder-runtime"});
  try {
    const captured = captureRun(fixture);
    assert.equal(captured.error, undefined, `${captured.stdout}\n${captured.stderr}`);
    assert.equal(captured.calls.length, 2);
    assert.match(captured.stdout, /E-012 copied decoder runtime/u);
    assert.equal(captured.stderr, "");
    assertTemporaryParentEmpty(fixture);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-012 decoder importer 近似路径不得触发运行时复制", () => {
  const fixture = createFixture({behavior: "decoder-near-match"});
  try {
    const captured = captureRun(fixture);
    assert.equal(captured.error, undefined);
    assert.equal(captured.calls.length, 2);
    assert.match(captured.stdout, /E-012 near-match does not copy decoder runtime/u);
    assert.equal(captured.stderr, "");
    assertTemporaryParentEmpty(fixture);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-012 精确 decoder importer 缺少任一固定运行时文件即失败关闭", () => {
  const fixture = createFixture({behavior: "decoder-runtime"});
  try {
    rmSync(resolve(fixture.root, "scripts/content/json.d.mts"));
    const captured = captureRun(fixture);
    assert.ok(hasTestCode("TEST_DECODER_RUNTIME")(captured.error));
    assert.equal(captured.calls.length, 1);
    assertTemporaryParentEmpty(fixture);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-012 空测试集在创建临时输出前失败关闭", () => {
  const fixture = createFixture({withSource: false});
  try {
    const captured = captureRun(fixture);
    assert.ok(hasTestCode("TEST_EMPTY")(captured.error));
    assert.deepEqual(captured.calls, []);
    assertTemporaryParentEmpty(fixture);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-012 编译失败后传播源码诊断并清理", () => {
  const fixture = createFixture({behavior: "compile-failure"});
  try {
    const captured = captureRun(fixture);
    assert.ok(hasTestCode("TEST_COMPILE")(captured.error));
    assert.match(captured.stderr, /tests\/build\/example\.test\.ts/u);
    assert.match(captured.stderr, /synthetic compile failure/u);
    assertTemporaryParentEmpty(fixture);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-012 emit 集合漂移失败且不留下部分成功", () => {
  const fixture = createFixture({behavior: "extra-emit"});
  try {
    const captured = captureRun(fixture);
    assert.ok(hasTestCode("TEST_EMIT")(captured.error));
    assert.equal(captured.calls.length, 1);
    assertTemporaryParentEmpty(fixture);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-012 测试失败保留源码测试路径与测试名且清理", () => {
  const fixture = createFixture({behavior: "test-failure"});
  try {
    const captured = captureRun(fixture);
    assert.ok(hasTestCode("TEST_EXECUTION")(captured.error));
    const diagnostic = `${captured.stdout}\n${captured.stderr}`;
    assert.match(diagnostic, /E-012 synthetic failing test/u);
    assert.match(diagnostic, /tests\/build\/example\.test\.ts/u);
    assert.doesNotMatch(diagnostic, /axial-muse-tests-/u);
    assert.ok(!diagnostic.includes(fixture.temporaryParent));
    assertTemporaryParentEmpty(fixture);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-012 清理失败覆盖成功状态并以稳定错误传播", () => {
  const fixture = createFixture();
  try {
    const captured = captureRun(fixture, {
      removeTemporary(path) {
        rmSync(path, {recursive: true, force: false});
        throw new Error("synthetic cleanup failure");
      },
    });
    assert.ok(hasTestCode("TEST_CLEANUP")(captured.error));
    assertTemporaryParentEmpty(fixture);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-012 临时目录创建失败不启动编译或测试", () => {
  const fixture = createFixture();
  try {
    const captured = captureRun(fixture, {
      makeTemporary() {
        throw new Error("synthetic temporary failure");
      },
    });
    assert.ok(hasTestCode("TEST_TEMPORARY")(captured.error));
    assert.deepEqual(captured.calls, []);
    assertTemporaryParentEmpty(fixture);
  } finally {
    destroyFixture(fixture);
  }
});

test("E-012 临时目录创建后身份校验失败仍清理已拥有路径", () => {
  const fixture = createFixture();
  try {
    const captured = captureRun(fixture, {
      makeTemporary(prefix) {
        const path = `${prefix}partial-file`;
        writeFileSync(path, "not a directory\n", "utf8");
        return path;
      },
    });
    assert.ok(hasTestCode("TEST_TEMPORARY")(captured.error));
    assert.deepEqual(captured.calls, []);
    assertTemporaryParentEmpty(fixture);
  } finally {
    destroyFixture(fixture);
  }
});

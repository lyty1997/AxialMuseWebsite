import {spawnSync} from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {pathToFileURL} from "node:url";
import {
  checkModuleBoundaries,
  writeModuleBoundaryResult,
} from "./check-module-boundaries.mjs";
import {projectRoot} from "./lib/files.mjs";
import {buildQualityChildEnvironment} from "./lib/process-environment.mjs";
import {
  readAndValidateManifest,
  readAndValidateRuntimeContract,
} from "./lib/supply-chain/config.mjs";

const ROOT = projectRoot();
const TEST_SOURCE_ROOTS = Object.freeze([
  "tests/domain",
  "tests/build",
]);
const TEMPORARY_PREFIX = "axial-muse-tests-";
const MAX_CHILD_OUTPUT_BYTES = 8 * 1024 * 1024;
const TEMPORARY_PACKAGE = `${JSON.stringify({
  type: "module",
  private: true,
}, null, 2)}\n`;

export class TestRunError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "TestRunError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new TestRunError(code, message, options);
}

export function formatTestRunError(error) {
  if (error instanceof TestRunError) {
    return `[${error.code}] ${error.message}`;
  }
  return "[TEST_INTERNAL] 测试入口发生未分类错误；详细堆栈已抑制，避免泄露本机路径或环境信息。";
}

export function parseTestArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length !== 0) {
    fail("TEST_ARGUMENTS", "测试入口不接受参数。");
  }
  return Object.freeze({});
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function relativeSourcePath(root, path) {
  return toPosix(relative(root, path));
}

function replaceLiteral(value, search, replacement) {
  return search.length === 0 ? value : value.split(search).join(replacement);
}

export function assertTestWorkspace({root = ROOT, cwd = process.cwd()} = {}) {
  try {
    const realRoot = realpathSync(root);
    const realCwd = realpathSync(cwd);
    const metadata = lstatSync(realRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || realRoot !== realCwd) {
      fail("TEST_WORKSPACE", "测试入口必须从仓库根普通目录运行。");
    }
    return realRoot;
  } catch (error) {
    if (error instanceof TestRunError) throw error;
    fail("TEST_WORKSPACE", "测试工作区无法可信解析。", {cause: error});
  }
}

export function assertSupportedTestNodeVersion({
  root = ROOT,
  nodeVersion = process.versions.node,
} = {}) {
  try {
    const manifest = readAndValidateManifest(root);
    const contract = readAndValidateRuntimeContract({root, manifest});
    const role = Object.entries(contract.nodeVersionsByRole)
      .find(([, version]) => version === nodeVersion)?.[0];
    if (role === undefined) {
      fail(
        "TEST_RUNTIME_NODE",
        "当前 Node 不属于 .nvmrc 主端点或 engines 下界端点。",
      );
    }
    return role;
  } catch (error) {
    if (error instanceof TestRunError) throw error;
    fail("TEST_RUNTIME_NODE", "Node 版本契约不可用。", {cause: error});
  }
}

function validateProgramBoundary({root, validateProgram, standardError}) {
  let result;
  try {
    result = validateProgram({root});
  } catch (error) {
    fail("TEST_PROGRAM", "测试 program 的模块边界检查无法完成。", {cause: error});
  }
  if (result === null || !Array.isArray(result?.issues)) {
    fail("TEST_PROGRAM", "测试 program 的模块边界结果格式不合法。");
  }
  if (result.issues.length > 0) {
    writeModuleBoundaryResult(result, {
      standardError,
      standardOutput: {write() {}},
    });
    fail("TEST_PROGRAM", "测试 program 未通过模块边界检查。");
  }
}

function readJsonObject(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("JSON root must be an object");
  }
  return value;
}

export function resolveTypeScriptCli({root = ROOT} = {}) {
  try {
    const lexicalPackageRoot = resolve(root, "node_modules", "typescript");
    const packageMetadata = lstatSync(lexicalPackageRoot);
    if (packageMetadata.isSymbolicLink() || !packageMetadata.isDirectory()) {
      fail("TEST_DEPENDENCIES", "本地 TypeScript 包目录类型不合法。");
    }
    const packageRoot = realpathSync(lexicalPackageRoot);
    if (packageRoot !== lexicalPackageRoot) {
      fail("TEST_DEPENDENCIES", "本地 TypeScript 包目录逃逸冻结安装树。");
    }

    const cliInput = resolve(packageRoot, "bin", "tsc");
    const cliMetadata = lstatSync(cliInput);
    const cliPath = realpathSync(cliInput);
    if (
      cliMetadata.isSymbolicLink()
      || !cliMetadata.isFile()
      || cliMetadata.nlink !== 1
      || (cliMetadata.mode & 0o002) !== 0
      || cliPath !== cliInput
      || relative(packageRoot, cliPath).startsWith("..")
    ) {
      fail("TEST_DEPENDENCIES", "本地 TypeScript CLI 身份或权限不合法。");
    }

    const installedManifest = readJsonObject(resolve(packageRoot, "package.json"));
    const lockfile = readJsonObject(resolve(root, "package-lock.json"));
    const lockedVersion = lockfile.packages?.["node_modules/typescript"]?.version;
    if (
      typeof installedManifest.version !== "string"
      || typeof lockedVersion !== "string"
      || installedManifest.version !== lockedVersion
    ) {
      fail("TEST_DEPENDENCIES", "本地 TypeScript 版本未绑定唯一 lockfile。");
    }
    return cliPath;
  } catch (error) {
    if (error instanceof TestRunError) throw error;
    fail("TEST_DEPENDENCIES", "本地冻结的 TypeScript CLI 不可用。", {cause: error});
  }
}

export function collectTypeScriptTestSources({root = ROOT} = {}) {
  const files = [];
  const walk = (directory) => {
    const entries = readdirSync(directory, {withFileTypes: true})
      .sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const relativePath = relativeSourcePath(root, path);
      if (entry.isSymbolicLink()) {
        fail("TEST_PROGRAM", "测试源码树不得包含符号链接。");
      }
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) {
        fail("TEST_PROGRAM", "测试源码树包含不受支持的文件类型。");
      }
      if (/\.test\.(?:js|jsx|tsx)$/u.test(entry.name)) {
        fail("TEST_PROGRAM", "领域与构建测试必须使用 .test.ts。");
      }
      if (entry.name.endsWith(".test.ts")) files.push({path, relativePath});
    }
  };

  try {
    for (const relativeRoot of TEST_SOURCE_ROOTS) {
      const directory = resolve(root, relativeRoot);
      const metadata = lstatSync(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        fail("TEST_PROGRAM", "测试物理层必须是仓库内普通目录。");
      }
      walk(directory);
    }
  } catch (error) {
    if (error instanceof TestRunError) throw error;
    fail("TEST_PROGRAM", "测试源码集合无法确定性枚举。", {cause: error});
  }

  files.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  if (files.length === 0) {
    fail("TEST_EMPTY", "tests/domain 与 tests/build 中没有 TypeScript 测试。");
  }
  return Object.freeze(files.map((file) => Object.freeze(file)));
}

function createTemporaryOutput({temporaryParent, makeTemporary, recordTemporary}) {
  let outputRoot;
  try {
    const realParent = realpathSync(temporaryParent);
    outputRoot = makeTemporary(join(realParent, TEMPORARY_PREFIX));
    if (
      typeof outputRoot !== "string"
      || !isAbsolute(outputRoot)
      || dirname(outputRoot) !== realParent
      || !outputRoot.startsWith(join(realParent, TEMPORARY_PREFIX))
    ) {
      fail("TEST_TEMPORARY", "临时测试输出目录不属于已验证的临时父目录。");
    }
    recordTemporary(outputRoot);
    chmodSync(outputRoot, 0o700);
    const metadata = lstatSync(outputRoot);
    const realOutputRoot = realpathSync(outputRoot);
    if (
      metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || (metadata.mode & 0o777) !== 0o700
      || dirname(realOutputRoot) !== realParent
      || !realOutputRoot.startsWith(join(realParent, TEMPORARY_PREFIX))
    ) {
      fail("TEST_TEMPORARY", "临时测试输出目录身份或权限不合法。");
    }
    return realOutputRoot;
  } catch (error) {
    if (error instanceof TestRunError) throw error;
    fail("TEST_TEMPORARY", "无法创建独占临时测试输出目录。", {cause: error});
  }
}

function childOutput(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

export function sanitizeTestDiagnostic(value, {
  root,
  outputRoot,
  mappings = [],
}) {
  let result = childOutput(value);
  for (const mapping of mappings) {
    const emittedUrl = pathToFileURL(mapping.emittedPath).href;
    const emittedFromRoot = relative(root, mapping.emittedPath);
    for (const candidate of [
      emittedUrl,
      mapping.emittedPath,
      toPosix(emittedFromRoot),
      emittedFromRoot,
      mapping.emittedRelativePath,
    ]) {
      result = replaceLiteral(result, candidate, mapping.sourceRelativePath);
    }
  }
  const outputUrl = `${pathToFileURL(outputRoot).href}/`;
  result = replaceLiteral(result, outputUrl, "<test-output>/");
  result = replaceLiteral(result, `${outputRoot}${sep}`, "<test-output>/");
  result = replaceLiteral(result, outputRoot, "<test-output>");
  const rootUrl = `${pathToFileURL(root).href}/`;
  result = replaceLiteral(result, rootUrl, "");
  result = replaceLiteral(result, `${root}${sep}`, "");
  return result;
}

function publishChildOutput(result, context) {
  const stdout = sanitizeTestDiagnostic(result?.stdout, context);
  const stderr = sanitizeTestDiagnostic(result?.stderr, context);
  if (stdout.length > 0) context.standardOutput.write(stdout);
  if (stderr.length > 0) context.standardError.write(stderr);
}

function spawnTestChild(spawnProcess, arguments_, {root}) {
  return spawnProcess(process.execPath, arguments_, {
    cwd: root,
    env: buildQualityChildEnvironment(),
    encoding: "utf8",
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assertChildSucceeded(result, code, message) {
  if (result?.error || result?.signal || result?.status !== 0) {
    fail(code, message, {cause: result?.error});
  }
}

function writeTemporaryPackage(outputRoot) {
  try {
    const packagePath = resolve(outputRoot, "package.json");
    writeFileSync(packagePath, TEMPORARY_PACKAGE, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(packagePath, 0o600);
  } catch (error) {
    fail("TEST_TEMPORARY", "无法写入临时 ESM package 边界。", {cause: error});
  }
}

function listEmittedTests(outputRoot) {
  const files = [];
  const walk = (directory) => {
    const entries = readdirSync(directory, {withFileTypes: true})
      .sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail("TEST_EMIT", "临时测试输出不得包含符号链接。");
      }
      if (entry.isDirectory()) {
        walk(path);
      } else if (!entry.isFile()) {
        fail("TEST_EMIT", "临时测试输出包含不受支持的文件类型。");
      } else if (entry.name.endsWith(".test.js")) {
        files.push(path);
      }
    }
  };
  try {
    walk(outputRoot);
  } catch (error) {
    if (error instanceof TestRunError) throw error;
    fail("TEST_EMIT", "无法确定性枚举编译后的测试集合。", {cause: error});
  }
  return files.sort((left, right) => compareUtf8(
    relativeSourcePath(outputRoot, left),
    relativeSourcePath(outputRoot, right),
  ));
}

function bindEmittedTests({root, outputRoot, sources}) {
  const expected = sources.map((source) => {
    const emittedRelativePath = source.relativePath.replace(/\.ts$/u, ".js");
    return {
      sourceRelativePath: source.relativePath,
      emittedRelativePath,
      emittedPath: resolve(outputRoot, emittedRelativePath),
    };
  });
  const actualPaths = listEmittedTests(outputRoot);
  const expectedPaths = expected.map((entry) => entry.emittedPath);
  if (
    actualPaths.length !== expectedPaths.length
    || actualPaths.some((path, index) => path !== expectedPaths[index])
  ) {
    fail("TEST_EMIT", "源码测试与编译后测试集合不是一一对应。");
  }
  for (const path of actualPaths) {
    const metadata = lstatSync(path);
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.nlink !== 1
      || !isAbsolute(path)
      || relative(outputRoot, path).startsWith("..")
    ) {
      fail("TEST_EMIT", "编译后测试文件身份或权限不合法。");
    }
  }
  return Object.freeze(expected.map((entry) => Object.freeze(entry)));
}

export function runTests({
  root = ROOT,
  cwd = process.cwd(),
  nodeVersion = process.versions.node,
  temporaryParent = tmpdir(),
  assertRuntime = assertSupportedTestNodeVersion,
  validateProgram = checkModuleBoundaries,
  resolveCompiler = resolveTypeScriptCli,
  makeTemporary = mkdtempSync,
  removeTemporary = (path) => rmSync(path, {recursive: true, force: false}),
  spawnProcess = spawnSync,
  standardOutput = process.stdout,
  standardError = process.stderr,
} = {}) {
  const realRoot = assertTestWorkspace({root, cwd});
  const runtimeRole = assertRuntime({root: realRoot, nodeVersion});
  validateProgramBoundary({root: realRoot, validateProgram, standardError});
  const sources = collectTypeScriptTestSources({root: realRoot});
  const compilerPath = resolveCompiler({root: realRoot});
  standardOutput.write(
    `TypeScript test sources (${sources.length}):\n${sources.map((source) => `- ${source.relativePath}`).join("\n")}\n`,
  );

  let outputRoot;
  let operationError;
  let cleanupError;
  let mappings = [];
  try {
    outputRoot = createTemporaryOutput({
      temporaryParent,
      makeTemporary,
      recordTemporary(path) {
        outputRoot = path;
      },
    });
    const compileResult = spawnTestChild(spawnProcess, [
      compilerPath,
      "-p",
      resolve(realRoot, "tests", "tsconfig.json"),
      "--outDir",
      outputRoot,
    ], {root: realRoot});
    publishChildOutput(compileResult, {
      root: realRoot,
      outputRoot,
      mappings,
      standardOutput,
      standardError,
    });
    assertChildSucceeded(compileResult, "TEST_COMPILE", "TypeScript 测试 program 编译失败。");

    writeTemporaryPackage(outputRoot);
    mappings = bindEmittedTests({root: realRoot, outputRoot, sources});
    const executionResult = spawnTestChild(
      spawnProcess,
      ["--test", ...mappings.map((mapping) => mapping.emittedPath)],
      {root: realRoot},
    );
    publishChildOutput(executionResult, {
      root: realRoot,
      outputRoot,
      mappings,
      standardOutput,
      standardError,
    });
    assertChildSucceeded(executionResult, "TEST_EXECUTION", "Node ESM 测试执行失败。");
  } catch (error) {
    operationError = error;
  } finally {
    if (outputRoot !== undefined) {
      try {
        removeTemporary(outputRoot);
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  if (cleanupError !== undefined) {
    fail("TEST_CLEANUP", "临时测试输出清理失败。", {cause: cleanupError});
  }
  if (operationError !== undefined) throw operationError;
  return Object.freeze({
    runtimeRole,
    sourceFiles: Object.freeze(sources.map((source) => source.relativePath)),
  });
}

function runCli() {
  try {
    parseTestArguments(process.argv.slice(2));
    const result = runTests();
    console.log(
      `TypeScript tests passed: ${result.sourceFiles.length} source files (${result.runtimeRole}).`,
    );
  } catch (error) {
    console.error(formatTestRunError(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}

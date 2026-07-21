import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DUAL_ENDPOINT_CI_INPUT_PATHS,
  DUAL_ENDPOINT_CI_RUNTIME,
  MINIMUM_NODE_DISTRIBUTION,
  downloadMinimumNodeArchive,
  dualEndpointCiReceiptBytes,
  extractMinimumNodeArchive,
  inspectAndAttestMinimumRuntime,
  inspectMinimumRuntime,
  runDualEndpointCi,
  validateDualEndpointCiReceipt,
  validateExtractedRuntimeTree,
} from "../../scripts/quality/lib/supply-chain/dual-endpoint-ci.mjs";
import { PROJECT_NPM_CONFIG } from "../../scripts/quality/lib/supply-chain/contracts.mjs";
import { deriveNpmCli } from "../../scripts/quality/lib/supply-chain/environment.mjs";
import { NpmIsolationError } from "../../scripts/quality/lib/supply-chain/errors.mjs";
import { canonicalJsonBytes } from "../../scripts/quality/lib/supply-chain/spdx.mjs";
import {
  main as workerMain,
  runDualEndpointCiWorker,
} from "../../scripts/quality/run-dual-endpoint-ci-worker.mjs";
import { main as parentMain } from "../../scripts/quality/run-dual-endpoint-ci.mjs";

const REAL_WORKER_PATH = fileURLToPath(new URL(
  "../../scripts/quality/run-dual-endpoint-ci-worker.mjs",
  import.meta.url,
));
const MIGRATION_CI_RUNTIMES = Object.freeze([
  Object.freeze({ nodeVersion: "22.22.0", npmVersion: "10.9.4" }),
  Object.freeze({ nodeVersion: "22.23.1", npmVersion: "10.9.8" }),
]);

function writePrivateFile(path, bytes) {
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function exactProjectNpmrc() {
  return `${Object.entries(PROJECT_NPM_CONFIG)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function createFixture() {
  const outer = mkdtempSync(join(tmpdir(), "axial-muse-dual-endpoint-test-"));
  chmodSync(outer, 0o700);
  const root = join(outer, "repo");
  const temporaryParent = join(outer, "temp");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(temporaryParent, { mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(temporaryParent, 0o700);
  writePrivateFile(join(root, ".npmrc"), "registry=https://registry.npmjs.org/\n");
  writePrivateFile(join(root, ".nvmrc"), "24.18.0\n");
  writePrivateFile(join(root, "package.json"), `${JSON.stringify({
    name: "fixture-root-name-must-not-enter-receipt",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: {
      "fixture-package-name-must-not-enter-receipt": "1.0.0",
    },
    engines: { node: ">=24.16.0 <25" },
  }, null, 2)}\n`);
  writePrivateFile(join(root, "package-lock.json"), `${JSON.stringify({
    name: "fixture-root-name-must-not-enter-receipt",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {},
  }, null, 2)}\n`);
  return { outer, root: resolve(root), temporaryParent: resolve(temporaryParent) };
}

function removeFixture(fixture) {
  rmSync(fixture.outer, { force: true, maxRetries: 2, recursive: true });
}

function fakePrimaryRuntime() {
  return {
    nodeExecutable: "/controlled/primary/node",
    ...DUAL_ENDPOINT_CI_RUNTIME.primary,
    role: "primary",
  };
}

function fakeMinimumRuntime(extractRoot) {
  const bin = join(extractRoot, "bin");
  mkdirSync(bin, { mode: 0o700 });
  chmodSync(bin, 0o700);
  const nodeExecutable = join(bin, "node");
  writeFileSync(nodeExecutable, "fixture node", { mode: 0o700 });
  chmodSync(nodeExecutable, 0o700);
  return {
    nodeExecutable,
    ...DUAL_ENDPOINT_CI_RUNTIME.minimum,
    role: "minimum",
  };
}

function expectedWorkerResult(role) {
  return { ...DUAL_ENDPOINT_CI_RUNTIME[role], role };
}

function response({
  chunks = [Buffer.from("fixture")],
  headers = {},
  statusCode = 200,
  url = MINIMUM_NODE_DISTRIBUTION.url,
} = {}) {
  let terminated = false;
  const body = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
  return {
    abort() { terminated = true; },
    body,
    destroy() { terminated = true; },
    headers,
    statusCode,
    get terminated() { return terminated; },
    url,
  };
}

function createRuntimeTree(parent, { npmVersion = "11.13.0" } = {}) {
  const runtimeRoot = join(parent, MINIMUM_NODE_DISTRIBUTION.expectedTopDirectory);
  const nodeBin = join(runtimeRoot, "bin");
  const npmRoot = join(runtimeRoot, "lib/node_modules/npm");
  mkdirSync(nodeBin, { mode: 0o755, recursive: true });
  mkdirSync(join(npmRoot, "bin"), { mode: 0o755, recursive: true });
  writeFileSync(join(nodeBin, "node"), "fixture", { mode: 0o755 });
  writeFileSync(join(npmRoot, "bin/npm-cli.js"), "fixture", { mode: 0o644 });
  writeFileSync(join(npmRoot, "package.json"), `${JSON.stringify({
    name: "npm",
    version: npmVersion,
    bin: { npm: "bin/npm-cli.js" },
  })}\n`, { mode: 0o644 });
  return runtimeRoot;
}

function assertCode(error, code) {
  return error instanceof NpmIsolationError && error.code === code;
}

test("D-077 双端点冻结安装离线自动化", async (suite) => {
  await suite.test("父入口零参数且内部 worker 只传入真实 cwd 与 ci profile", async () => {
    const fixture = createFixture();
    try {
      let call;
      const result = runDualEndpointCiWorker({
        cwd: fixture.root,
        runNpm(options) {
          call = options;
          return { runtime: expectedWorkerResult("primary") };
        },
      });
      assert.deepEqual(call, { root: fixture.root, profile: "ci" });
      assert.deepEqual(result, expectedWorkerResult("primary"));
      assert.throws(
        () => workerMain(["--root", fixture.root]),
        (error) => assertCode(error, "DUAL_ENDPOINT_CI_WORKER_ARGUMENTS"),
      );
      await assert.rejects(
        parentMain(["--root", fixture.root]),
        (error) => assertCode(error, "DUAL_ENDPOINT_CI_ARGUMENTS"),
      );
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("正式端点真实运行空依赖 npm ci，迁移 runner 失败关闭", () => {
    const fixture = createFixture();
    const packageName = "dual-endpoint-real-worker-fixture";
    try {
      const currentRuntime = {
        nodeVersion: process.versions.node,
        npmVersion: deriveNpmCli(process.execPath).npmVersion,
      };
      const currentRole = Object.entries(DUAL_ENDPOINT_CI_RUNTIME)
        .find(([, runtime]) => (
          runtime.nodeVersion === currentRuntime.nodeVersion
          && runtime.npmVersion === currentRuntime.npmVersion
        ))?.[0];
      if (currentRole === undefined) {
        assert.ok(MIGRATION_CI_RUNTIMES.some((runtime) => (
          runtime.nodeVersion === currentRuntime.nodeVersion
          && runtime.npmVersion === currentRuntime.npmVersion
        )), `未审查迁移 runner ${currentRuntime.nodeVersion}/npm${currentRuntime.npmVersion}。`);
      }
      writePrivateFile(join(fixture.root, ".npmrc"), exactProjectNpmrc());
      writePrivateFile(join(fixture.root, "package.json"), `${JSON.stringify({
        name: packageName,
        version: "1.0.0",
        private: true,
        type: "module",
        engines: { node: ">=24.16.0 <25" },
      }, null, 2)}\n`);
      writePrivateFile(join(fixture.root, "package-lock.json"), `${JSON.stringify({
        name: packageName,
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: packageName,
            version: "1.0.0",
            engines: { node: ">=24.16.0 <25" },
          },
        },
      }, null, 2)}\n`);

      const result = spawnSync(process.execPath, [REAL_WORKER_PATH], {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: "/usr/bin:/bin",
        },
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      if (currentRole === undefined) {
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.equal(
          result.stderr,
          "[NPM_RUNTIME_NODE] 当前 Node 既不是 .nvmrc 主端点，也不是 engines 下界端点。\n",
        );
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.equal(result.stdout, canonicalJsonBytes(expectedWorkerResult(currentRole)));
      }
      assert.equal(existsSync(join(fixture.root, "node_modules")), false);
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("两端只安装到临时 project 并留下最小 canonical receipt", async () => {
    const fixture = createFixture();
    const calls = [];
    try {
      const result = await runDualEndpointCi({
        root: fixture.root,
        temporaryParent: fixture.temporaryParent,
        verifyHostRuntime: fakePrimaryRuntime,
        prepareMinimumRuntime({ extractRoot }) {
          return fakeMinimumRuntime(extractRoot);
        },
        runWorker({ nodeExecutable, projectRoot, role }) {
          calls.push({ nodeExecutable, projectRoot, role });
          const dependencyTree = join(projectRoot, "node_modules/fixture");
          mkdirSync(dependencyTree, { mode: 0o700, recursive: true });
          writeFileSync(join(dependencyTree, "index.js"), "fixture", { mode: 0o600 });
          return expectedWorkerResult(role);
        },
      });
      assert.deepEqual(calls.map(({ role }) => role), ["primary", "minimum"]);
      assert.equal(calls[0].nodeExecutable, "/controlled/primary/node");
      assert.match(calls[1].nodeExecutable, /minimum-runtime\/bin\/node$/);
      assert.equal(existsSync(join(fixture.root, "node_modules")), false);
      assert.equal(calls.every(({ projectRoot }) => !existsSync(projectRoot)), true);

      const receiptStat = lstatSync(result.receiptPath);
      const directoryStat = lstatSync(dirname(result.receiptPath));
      assert.equal(receiptStat.isFile(), true);
      assert.equal(receiptStat.mode & 0o777, 0o600);
      assert.equal(directoryStat.mode & 0o777, 0o700);
      const receiptText = readFileSync(result.receiptPath, "utf8");
      assert.equal(receiptText, canonicalJsonBytes(JSON.parse(receiptText)));
      assert.equal(receiptText.includes("fixture-package-name"), false);
      assert.equal(receiptText.includes("fixture-root-name"), false);
      assert.equal(receiptText.includes("PATH"), false);
      assert.equal(receiptText.includes(fixture.root), false);
      assert.deepEqual(validateDualEndpointCiReceipt(JSON.parse(receiptText)), result.receipt);
      assert.equal(dualEndpointCiReceiptBytes(result.receipt), receiptText);
      assert.deepEqual(
        result.receipt.endpoints.map(({ role, nodeVersion, npmVersion }) => ({
          role,
          nodeVersion,
          npmVersion,
        })),
        [
          { role: "primary", ...DUAL_ENDPOINT_CI_RUNTIME.primary },
          { role: "minimum", ...DUAL_ENDPOINT_CI_RUNTIME.minimum },
        ],
      );
      assert.deepEqual(Object.keys(result.receipt.inputs), DUAL_ENDPOINT_CI_INPUT_PATHS);
      const remaining = readdirSync(fixture.temporaryParent);
      assert.deepEqual(remaining, [dirname(result.receiptPath).split("/").at(-1)]);
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("根输入在 snapshot 后漂移时不启动端点", async () => {
    const fixture = createFixture();
    let workers = 0;
    try {
      await assert.rejects(
        runDualEndpointCi({
          root: fixture.root,
          temporaryParent: fixture.temporaryParent,
          verifyHostRuntime: fakePrimaryRuntime,
          afterInputSnapshot() {
            writePrivateFile(join(fixture.root, "package.json"), "{}\n");
          },
          prepareMinimumRuntime() {
            throw new Error("must not run");
          },
          runWorker() {
            workers += 1;
          },
        }),
        (error) => assertCode(error, "DUAL_ENDPOINT_CI_INPUT_DRIFT"),
      );
      assert.equal(workers, 0);
      assert.equal(existsSync(join(fixture.root, "node_modules")), false);
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("根预存 node_modules 时失败且不删除", async () => {
    const fixture = createFixture();
    try {
      mkdirSync(join(fixture.root, "node_modules"), { mode: 0o700 });
      writePrivateFile(join(fixture.root, "node_modules/owned-by-user"), "keep");
      await assert.rejects(
        runDualEndpointCi({
          root: fixture.root,
          temporaryParent: fixture.temporaryParent,
          verifyHostRuntime: fakePrimaryRuntime,
        }),
        (error) => assertCode(error, "DUAL_ENDPOINT_CI_ROOT_NODE_MODULES"),
      );
      assert.equal(readFileSync(join(fixture.root, "node_modules/owned-by-user"), "utf8"), "keep");
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("端点执行期间出现根 node_modules 时失败并保留外部路径", async () => {
    const fixture = createFixture();
    try {
      await assert.rejects(
        runDualEndpointCi({
          root: fixture.root,
          temporaryParent: fixture.temporaryParent,
          verifyHostRuntime: fakePrimaryRuntime,
          prepareMinimumRuntime({ extractRoot }) {
            return fakeMinimumRuntime(extractRoot);
          },
          runWorker({ role }) {
            if (role === "primary") {
              mkdirSync(join(fixture.root, "node_modules"), { mode: 0o700 });
              writePrivateFile(join(fixture.root, "node_modules/external"), "keep");
            }
            return expectedWorkerResult(role);
          },
        }),
        (error) => assertCode(error, "DUAL_ENDPOINT_CI_ROOT_NODE_MODULES"),
      );
      assert.equal(readFileSync(join(fixture.root, "node_modules/external"), "utf8"), "keep");
      assert.equal(readdirSync(fixture.temporaryParent).length, 0);
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("端点失败同时发生根安全漂移时优先报告根漂移", async () => {
    const fixture = createFixture();
    try {
      await assert.rejects(
        runDualEndpointCi({
          root: fixture.root,
          temporaryParent: fixture.temporaryParent,
          verifyHostRuntime: fakePrimaryRuntime,
          runWorker() {
            mkdirSync(join(fixture.root, "node_modules"), { mode: 0o700 });
            throw new Error("synthetic endpoint failure");
          },
        }),
        (error) => assertCode(error, "DUAL_ENDPOINT_CI_ROOT_NODE_MODULES"),
      );
      assert.equal(existsSync(join(fixture.root, "node_modules")), true);
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("最低运行时在 worker 窗口漂移时不产生成功 receipt", async () => {
    const fixture = createFixture();
    try {
      await assert.rejects(
        runDualEndpointCi({
          root: fixture.root,
          temporaryParent: fixture.temporaryParent,
          verifyHostRuntime: fakePrimaryRuntime,
          prepareMinimumRuntime({ extractRoot }) {
            return fakeMinimumRuntime(extractRoot);
          },
          runWorker({ nodeExecutable, role }) {
            if (role === "minimum") {
              writeFileSync(nodeExecutable, "mutated runtime", { mode: 0o700 });
            }
            return expectedWorkerResult(role);
          },
        }),
        (error) => assertCode(error, "DUAL_ENDPOINT_CI_MINIMUM_RUNTIME_DRIFT"),
      );
      assert.deepEqual(readdirSync(fixture.temporaryParent), []);
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("最低 worker 抛错或结果校验失败时仍以运行时漂移优先", async () => {
    for (const scenario of ["throw", "invalid-result"]) {
      const fixture = createFixture();
      try {
        await assert.rejects(
          runDualEndpointCi({
            root: fixture.root,
            temporaryParent: fixture.temporaryParent,
            verifyHostRuntime: fakePrimaryRuntime,
            prepareMinimumRuntime({ extractRoot }) {
              return fakeMinimumRuntime(extractRoot);
            },
            runWorker({ nodeExecutable, role }) {
              if (role === "minimum") {
                writeFileSync(nodeExecutable, "mutated runtime", { mode: 0o700 });
                if (scenario === "throw") throw new Error("synthetic worker failure");
                return { role: "minimum" };
              }
              return expectedWorkerResult(role);
            },
          }),
          (error) => assertCode(error, "DUAL_ENDPOINT_CI_MINIMUM_RUNTIME_DRIFT"),
        );
        assert.deepEqual(readdirSync(fixture.temporaryParent), []);
      } finally {
        removeFixture(fixture);
      }
    }
  });

  await suite.test("主端点和最低端点失败使用各自稳定错误且清理临时树", async () => {
    for (const failingRole of ["primary", "minimum"]) {
      const fixture = createFixture();
      try {
        await assert.rejects(
          runDualEndpointCi({
            root: fixture.root,
            temporaryParent: fixture.temporaryParent,
            verifyHostRuntime: fakePrimaryRuntime,
            prepareMinimumRuntime({ extractRoot }) {
              return fakeMinimumRuntime(extractRoot);
            },
            runWorker({ role }) {
              if (role === failingRole) throw new Error("sensitive child failure");
              return expectedWorkerResult(role);
            },
          }),
          (error) => assertCode(
            error,
            failingRole === "primary"
              ? "DUAL_ENDPOINT_CI_PRIMARY_FAILED"
              : "DUAL_ENDPOINT_CI_MINIMUM_FAILED",
          ),
        );
        assert.equal(readdirSync(fixture.temporaryParent).length, 0);
      } finally {
        removeFixture(fixture);
      }
    }
  });

  await suite.test("临时 project manifest 漂移失败且仍安全清理", async () => {
    const fixture = createFixture();
    try {
      await assert.rejects(
        runDualEndpointCi({
          root: fixture.root,
          temporaryParent: fixture.temporaryParent,
          verifyHostRuntime: fakePrimaryRuntime,
          prepareMinimumRuntime({ extractRoot }) {
            return fakeMinimumRuntime(extractRoot);
          },
          runWorker({ projectRoot, role }) {
            if (role === "primary") {
              writePrivateFile(join(projectRoot, "package.json"), "{}\n");
            }
            return expectedWorkerResult(role);
          },
        }),
        (error) => assertCode(error, "DUAL_ENDPOINT_CI_PRIMARY_DRIFT"),
      );
      assert.equal(readdirSync(fixture.temporaryParent).length, 0);
      assert.equal(existsSync(join(fixture.root, "node_modules")), false);
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("cleanup 所有权检查后的 workspace 替换被保留并失败关闭", async () => {
    const fixture = createFixture();
    let replacedPath;
    let originalPath;
    try {
      await assert.rejects(
        runDualEndpointCi({
          root: fixture.root,
          temporaryParent: fixture.temporaryParent,
          verifyHostRuntime: fakePrimaryRuntime,
          prepareMinimumRuntime({ extractRoot }) {
            return fakeMinimumRuntime(extractRoot);
          },
          runWorker({ role }) {
            return expectedWorkerResult(role);
          },
          afterCleanupOwnershipCheck(path) {
            originalPath = `${path}.moved-by-test`;
            replacedPath = path;
            renameSync(path, originalPath);
            mkdirSync(path, { mode: 0o700 });
            chmodSync(path, 0o700);
            writePrivateFile(join(path, "external"), "keep");
          },
        }),
        (error) => assertCode(error, "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN"),
      );
      assert.equal(readFileSync(join(replacedPath, "external"), "utf8"), "keep");
      assert.equal(existsSync(originalPath), true);
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("quarantine 完整快照后的文件替换不被删除", async () => {
    const fixture = createFixture();
    let replacement;
    try {
      await assert.rejects(
        runDualEndpointCi({
          root: fixture.root,
          temporaryParent: fixture.temporaryParent,
          verifyHostRuntime: fakePrimaryRuntime,
          prepareMinimumRuntime({ extractRoot }) {
            return fakeMinimumRuntime(extractRoot);
          },
          runWorker({ role }) {
            return expectedWorkerResult(role);
          },
          afterCleanupTreeSnapshot({ quarantinePath }) {
            replacement = join(quarantinePath, "primary-project/package.json");
            renameSync(replacement, `${replacement}.task-original`);
            writePrivateFile(replacement, "external replacement");
          },
        }),
        (error) => assertCode(error, "DUAL_ENDPOINT_CI_CLEANUP_UNCERTAIN"),
      );
      assert.equal(readFileSync(replacement, "utf8"), "external replacement");
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("下载成功路径固定 URL、无跳转且校验摘要", async () => {
    const body = Buffer.from("offline fixture archive");
    let requested;
    const archive = await downloadMinimumNodeArchive({
      request(options) {
        requested = options;
        return response({
          chunks: [body],
          headers: { "content-length": String(body.length) },
        });
      },
      calculateSha256(bytes) {
        assert.equal(bytes.equals(body), true);
        return MINIMUM_NODE_DISTRIBUTION.sha256;
      },
    });
    assert.equal(requested.url.href, MINIMUM_NODE_DISTRIBUTION.url);
    assert.equal(archive.equals(body), true);
    archive.fill(0);
  });

  await suite.test("下载拒绝 redirect、非 200、超限与真实摘要不匹配", async () => {
    const redirected = response({ headers: { location: "https://example.invalid/node.tar.xz" } });
    await assert.rejects(
      downloadMinimumNodeArchive({ request: () => redirected }),
      (error) => assertCode(error, "DUAL_ENDPOINT_CI_DOWNLOAD_REDIRECT"),
    );
    assert.equal(redirected.terminated, true);

    const missing = response({ statusCode: 404 });
    await assert.rejects(
      downloadMinimumNodeArchive({ request: () => missing }),
      (error) => assertCode(error, "DUAL_ENDPOINT_CI_DOWNLOAD_RESPONSE"),
    );
    assert.equal(missing.terminated, true);

    const oversized = response({
      headers: { "content-length": String(MINIMUM_NODE_DISTRIBUTION.maxBytes + 1) },
    });
    await assert.rejects(
      downloadMinimumNodeArchive({ request: () => oversized }),
      (error) => assertCode(error, "DUAL_ENDPOINT_CI_DOWNLOAD_LIMIT"),
    );
    assert.equal(oversized.terminated, true);

    await assert.rejects(
      downloadMinimumNodeArchive({ request: () => response() }),
      (error) => assertCode(error, "DUAL_ENDPOINT_CI_DOWNLOAD_INTEGRITY"),
    );
  });

  await suite.test("受控 tar 只接受单一预期顶层并使用固定参数", () => {
    const fixture = createFixture();
    const archivePath = join(fixture.temporaryParent, MINIMUM_NODE_DISTRIBUTION.archiveFileName);
    const extractRoot = join(fixture.temporaryParent, "extract");
    try {
      writePrivateFile(archivePath, "offline archive");
      mkdirSync(extractRoot, { mode: 0o700 });
      chmodSync(extractRoot, 0o700);
      let invocation;
      const runtimeRoot = extractMinimumNodeArchive({
        archivePath,
        extractRoot,
        calculateSha256: () => MINIMUM_NODE_DISTRIBUTION.sha256,
        runProcess(executable, arguments_, options) {
          invocation = { executable, arguments_, options };
          assert.equal(options.input.toString("utf8"), "offline archive");
          createRuntimeTree(extractRoot);
          return { status: 0, signal: null, stderr: "", stdout: "" };
        },
      });
      assert.equal(runtimeRoot, join(extractRoot, MINIMUM_NODE_DISTRIBUTION.expectedTopDirectory));
      assert.equal(invocation.executable, "/usr/bin/tar");
      assert.deepEqual(invocation.arguments_, [
        "--extract",
        "--xz",
        "--file",
        "-",
        "--directory",
        "/proc/self/fd/3",
        "--no-same-owner",
        "--no-same-permissions",
      ]);
      assert.equal(invocation.options.cwd, extractRoot);
      assert.equal(invocation.options.stdio.length, 4);
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("真实 /usr/bin/tar 从 stdin 向 fd3 解压离线 tar.xz", () => {
    const fixture = createFixture();
    const sourceRoot = join(fixture.temporaryParent, "tar-source");
    const sourceRuntime = join(sourceRoot, MINIMUM_NODE_DISTRIBUTION.expectedTopDirectory);
    const archivePath = join(fixture.temporaryParent, "offline-runtime.tar.xz");
    const extractRoot = join(fixture.temporaryParent, "real-extract");
    try {
      mkdirSync(join(sourceRuntime, "bin"), { mode: 0o700, recursive: true });
      writePrivateFile(join(sourceRuntime, "bin/node"), "offline node fixture\n");
      mkdirSync(extractRoot, { mode: 0o700 });
      chmodSync(extractRoot, 0o700);
      const createResult = spawnSync("/usr/bin/tar", [
        "--create",
        "--xz",
        "--file",
        archivePath,
        "--directory",
        sourceRoot,
        MINIMUM_NODE_DISTRIBUTION.expectedTopDirectory,
      ], {
        encoding: "utf8",
        env: {
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: "/usr/bin:/bin",
        },
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      assert.equal(createResult.error, undefined);
      assert.equal(createResult.signal, null);
      assert.equal(createResult.status, 0, createResult.stderr);
      chmodSync(archivePath, 0o600);

      const runtimeRoot = extractMinimumNodeArchive({
        archivePath,
        extractRoot,
        calculateSha256: () => MINIMUM_NODE_DISTRIBUTION.sha256,
      });
      assert.equal(runtimeRoot, join(extractRoot, MINIMUM_NODE_DISTRIBUTION.expectedTopDirectory));
      assert.equal(readFileSync(join(runtimeRoot, "bin/node"), "utf8"), "offline node fixture\n");
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("tar 只消费已校验快照并拒绝 archive 执行期漂移", () => {
    const fixture = createFixture();
    const archivePath = join(fixture.temporaryParent, MINIMUM_NODE_DISTRIBUTION.archiveFileName);
    const extractRoot = join(fixture.temporaryParent, "extract");
    try {
      writePrivateFile(archivePath, "verified archive bytes");
      mkdirSync(extractRoot, { mode: 0o700 });
      chmodSync(extractRoot, 0o700);
      assert.throws(
        () => extractMinimumNodeArchive({
          archivePath,
          extractRoot,
          calculateSha256: () => MINIMUM_NODE_DISTRIBUTION.sha256,
          runProcess(_executable, _arguments, options) {
            assert.equal(options.input.toString("utf8"), "verified archive bytes");
            writePrivateFile(archivePath, "unverified replacement");
            createRuntimeTree(extractRoot);
            return { status: 0, signal: null, stderr: "", stdout: "" };
          },
        }),
        (error) => assertCode(error, "DUAL_ENDPOINT_CI_TAR_INPUT"),
      );
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("tar 抛错后仍复核 archive 漂移并覆盖进程错误", () => {
    const fixture = createFixture();
    const archivePath = join(fixture.temporaryParent, MINIMUM_NODE_DISTRIBUTION.archiveFileName);
    const extractRoot = join(fixture.temporaryParent, "extract");
    try {
      writePrivateFile(archivePath, "verified archive bytes");
      mkdirSync(extractRoot, { mode: 0o700 });
      chmodSync(extractRoot, 0o700);
      assert.throws(
        () => extractMinimumNodeArchive({
          archivePath,
          extractRoot,
          calculateSha256: () => MINIMUM_NODE_DISTRIBUTION.sha256,
          runProcess() {
            writePrivateFile(archivePath, "mutated before throw");
            throw new Error("synthetic tar spawn failure");
          },
        }),
        (error) => assertCode(error, "DUAL_ENDPOINT_CI_TAR_INPUT"),
      );
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("tar 非零状态后仍复核 extract 目录替换并优先报告漂移", () => {
    const fixture = createFixture();
    const archivePath = join(fixture.temporaryParent, MINIMUM_NODE_DISTRIBUTION.archiveFileName);
    const extractRoot = join(fixture.temporaryParent, "extract");
    try {
      writePrivateFile(archivePath, "verified archive bytes");
      mkdirSync(extractRoot, { mode: 0o700 });
      chmodSync(extractRoot, 0o700);
      assert.throws(
        () => extractMinimumNodeArchive({
          archivePath,
          extractRoot,
          calculateSha256: () => MINIMUM_NODE_DISTRIBUTION.sha256,
          runProcess() {
            renameSync(extractRoot, `${extractRoot}.task-original`);
            mkdirSync(extractRoot, { mode: 0o700 });
            chmodSync(extractRoot, 0o700);
            return { status: 2, signal: null, stderr: "synthetic", stdout: "" };
          },
        }),
        (error) => assertCode(error, "DUAL_ENDPOINT_CI_TAR_INPUT"),
      );
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("tar result.error 与 signal 都按稳定失败关闭", () => {
    for (const result of [
      { error: new Error("synthetic spawn error"), status: null, signal: null },
      { status: null, signal: "SIGTERM" },
    ]) {
      const fixture = createFixture();
      const archivePath = join(
        fixture.temporaryParent,
        MINIMUM_NODE_DISTRIBUTION.archiveFileName,
      );
      const extractRoot = join(fixture.temporaryParent, "extract");
      try {
        writePrivateFile(archivePath, "verified archive bytes");
        mkdirSync(extractRoot, { mode: 0o700 });
        chmodSync(extractRoot, 0o700);
        assert.throws(
          () => extractMinimumNodeArchive({
            archivePath,
            extractRoot,
            calculateSha256: () => MINIMUM_NODE_DISTRIBUTION.sha256,
            runProcess() {
              return { stderr: "synthetic", stdout: "", ...result };
            },
          }),
          (error) => assertCode(error, "DUAL_ENDPOINT_CI_TAR_FAILED"),
        );
      } finally {
        removeFixture(fixture);
      }
    }
  });

  await suite.test("tar 布局和运行时链接逃逸失败关闭", () => {
    for (const scenario of ["wrong-top", "escaping-link"]) {
      const fixture = createFixture();
      const archivePath = join(fixture.temporaryParent, MINIMUM_NODE_DISTRIBUTION.archiveFileName);
      const extractRoot = join(fixture.temporaryParent, "extract");
      try {
        writePrivateFile(archivePath, "offline archive");
        mkdirSync(extractRoot, { mode: 0o700 });
        chmodSync(extractRoot, 0o700);
        assert.throws(
          () => extractMinimumNodeArchive({
            archivePath,
            extractRoot,
            calculateSha256: () => MINIMUM_NODE_DISTRIBUTION.sha256,
            runProcess() {
              if (scenario === "wrong-top") {
                mkdirSync(join(extractRoot, "wrong"), { mode: 0o755 });
              } else {
                const runtimeRoot = createRuntimeTree(extractRoot);
                symlinkSync("/tmp", join(runtimeRoot, "escape"));
              }
              return { status: 0, signal: null, stderr: "", stdout: "" };
            },
          }),
          (error) => assertCode(
            error,
            scenario === "wrong-top"
              ? "DUAL_ENDPOINT_CI_TAR_LAYOUT"
              : "DUAL_ENDPOINT_CI_RUNTIME_TREE",
          ),
        );
      } finally {
        removeFixture(fixture);
      }
    }
  });

  await suite.test("最低运行时精确验证 Node/npm 并拒绝版本漂移", () => {
    for (const scenario of ["pass", "node-mismatch", "npm-mismatch"]) {
      const fixture = createFixture();
      try {
        const runtimeRoot = createRuntimeTree(fixture.temporaryParent, {
          npmVersion: scenario === "npm-mismatch" ? "11.13.1" : "11.13.0",
        });
        const execute = () => inspectMinimumRuntime({
          runtimeRoot,
          runProcess() {
            return {
              status: 0,
              signal: null,
              stderr: "",
              stdout: scenario === "node-mismatch" ? "24.16.1" : "24.16.0",
            };
          },
        });
        if (scenario === "pass") {
          const runtime = execute();
          assert.deepEqual(
            { role: runtime.role, nodeVersion: runtime.nodeVersion, npmVersion: runtime.npmVersion },
            expectedWorkerResult("minimum"),
          );
          assert.equal(runtime.nodeExecutable, realpathSync(join(runtimeRoot, "bin/node")));
        } else {
          assert.throws(
            execute,
            (error) => assertCode(error, "DUAL_ENDPOINT_CI_MINIMUM_RUNTIME"),
          );
        }
      } finally {
        removeFixture(fixture);
      }
    }
  });

  await suite.test("最低运行时探针抛错时仍复核完整信任树并优先报告漂移", () => {
    const fixture = createFixture();
    try {
      const runtimeRoot = createRuntimeTree(fixture.temporaryParent);
      assert.throws(
        () => inspectAndAttestMinimumRuntime({
          runtimeRoot,
          inspectRuntime() {
            writeFileSync(join(runtimeRoot, "bin/node"), "mutated during failed probe", {
              mode: 0o755,
            });
            throw new Error("synthetic probe failure");
          },
        }),
        (error) => assertCode(error, "DUAL_ENDPOINT_CI_MINIMUM_RUNTIME_DRIFT"),
      );
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("receipt schema 拒绝附加包名字段和前后漂移", () => {
    const hash = "a".repeat(64);
    const receipt = {
      version: "0.1.0",
      kind: "axial_muse_dual_endpoint_ci_receipt",
      status: "passed",
      owner: "AxialMuseWebsite",
      inputs: Object.fromEntries(DUAL_ENDPOINT_CI_INPUT_PATHS.map((path) => [path, hash])),
      endpoints: [
        {
          role: "primary",
          ...DUAL_ENDPOINT_CI_RUNTIME.primary,
          before: { manifestSha256: hash, lockfileSha256: hash },
          after: { manifestSha256: hash, lockfileSha256: hash },
        },
        {
          role: "minimum",
          ...DUAL_ENDPOINT_CI_RUNTIME.minimum,
          before: { manifestSha256: hash, lockfileSha256: hash },
          after: { manifestSha256: hash, lockfileSha256: hash },
        },
      ],
    };
    assert.deepEqual(validateDualEndpointCiReceipt(receipt), receipt);
    assert.throws(
      () => validateDualEndpointCiReceipt({ ...receipt, packageNames: ["secret"] }),
      (error) => assertCode(error, "DUAL_ENDPOINT_CI_RECEIPT_SCHEMA"),
    );
    const drifted = structuredClone(receipt);
    drifted.endpoints[1].after.lockfileSha256 = "b".repeat(64);
    assert.throws(
      () => validateDualEndpointCiReceipt(drifted),
      (error) => assertCode(error, "DUAL_ENDPOINT_CI_RECEIPT_SCHEMA"),
    );
  });
});

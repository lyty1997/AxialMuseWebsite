import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import test from "node:test";
import {
  captureFrozenInstalledTreeEvidence,
  parsePreviewDependencyArguments,
  PreviewDependencyError,
} from "../../scripts/dev/preview-dependencies.mjs";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

function hasDependencyCode(code) {
  return (error) => error instanceof PreviewDependencyError && error.code === code;
}

test("E-009 preview 冻结依赖命令只接受 prepare/verify", () => {
  assert.deepEqual(parsePreviewDependencyArguments(["prepare"]), {command: "prepare"});
  assert.deepEqual(parsePreviewDependencyArguments(["verify"]), {command: "verify"});
  assert.throws(
    () => parsePreviewDependencyArguments([]),
    hasDependencyCode("PREVIEW_DEPENDENCY_ARGUMENTS"),
  );
  assert.throws(
    () => parsePreviewDependencyArguments(["verify", "extra"]),
    hasDependencyCode("PREVIEW_DEPENDENCY_ARGUMENTS"),
  );
});

test("E-009 preview.sh 通过 Bash 静态语法检查", {
  skip: process.platform !== "linux",
}, () => {
  const result = spawnSync("bash", ["-n", resolve(PROJECT_ROOT, "scripts/dev/preview.sh")], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
});

test("E-009 自包含安装树可形成逐字节冻结证据并识别漂移", {
  skip: process.platform !== "linux",
}, () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "axial-muse-preview-tree-"));
  const nodeModulesRoot = resolve(fixtureRoot, "node_modules");
  const packageRoot = resolve(nodeModulesRoot, "demo");
  const binRoot = resolve(nodeModulesRoot, ".bin");
  const executablePath = resolve(packageRoot, "cli.mjs");
  try {
    mkdirSync(packageRoot, {mode: 0o700, recursive: true});
    mkdirSync(binRoot, {mode: 0o700});
    writeFileSync(executablePath, "export default 'before';\n", {mode: 0o600});
    symlinkSync("../demo/cli.mjs", resolve(binRoot, "demo"));

    const before = captureFrozenInstalledTreeEvidence(nodeModulesRoot);
    assert.equal(before.treeEntryCount, 4);
    assert.match(before.treeSha256, /^[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(before), true);

    writeFileSync(executablePath, "export default 'after';\n", {mode: 0o600});
    const after = captureFrozenInstalledTreeEvidence(nodeModulesRoot);
    assert.equal(after.treeEntryCount, before.treeEntryCount);
    assert.notEqual(after.treeSha256, before.treeSha256);
  } finally {
    rmSync(fixtureRoot, {recursive: true, force: true});
  }
});

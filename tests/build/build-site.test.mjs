import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {
  assertBaselineInputs,
  assertBuildModeAvailable,
  assertSupportedNodeVersion,
  BuildSiteError,
  parseBuildArguments,
} from "../../scripts/build/build-site.mjs";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

function hasBuildCode(code) {
  return (error) => error instanceof BuildSiteError && error.code === code;
}

function writeFixture(root, relativePath, contents = "") {
  const path = resolve(root, relativePath);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, contents, "utf8");
}

function createBaselineRoot() {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-build-input-"));
  writeFixture(root, "site-content/projects/.gitkeep", "fixture\n");
  writeFixture(root, "site-content/writing/.gitkeep", "fixture\n");
  return root;
}

test("I-12 构建参数封闭解析 production/preview 且 preview 执行仍由 #8 失败关闭", () => {
  assert.deepEqual(parseBuildArguments(["--mode", "production"]), {mode: "production"});
  assert.deepEqual(parseBuildArguments(["--mode", "preview"]), {mode: "preview"});
  assert.doesNotThrow(() => assertBuildModeAvailable("production"));
  assert.throws(() => assertBuildModeAvailable("preview"), hasBuildCode("BUILD_MODE_UNAVAILABLE"));
  assert.throws(() => parseBuildArguments([]), hasBuildCode("BUILD_ARGUMENTS"));
  assert.throws(
    () => parseBuildArguments(["--mode", "other"]),
    hasBuildCode("BUILD_MODE"),
  );
});

test("D-067 构建入口只接受主 Node 与 engines 下界", () => {
  assert.equal(
    assertSupportedNodeVersion({root: PROJECT_ROOT, nodeVersion: "24.18.0"}),
    "primary",
  );
  assert.equal(
    assertSupportedNodeVersion({root: PROJECT_ROOT, nodeVersion: "24.16.0"}),
    "minimum",
  );
  assert.throws(
    () => assertSupportedNodeVersion({root: PROJECT_ROOT, nodeVersion: "22.22.0"}),
    hasBuildCode("BUILD_RUNTIME_NODE"),
  );
});

test("I-04 空内容基线通过且真实内容失败关闭", () => {
  const root = createBaselineRoot();
  try {
    assert.doesNotThrow(() => assertBaselineInputs(root));
    writeFixture(root, "site-content/writing/example/index.md", "# fixture\n");
    assert.throws(
      () => assertBaselineInputs(root),
      hasBuildCode("BUILD_PIPELINE_INCOMPLETE"),
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("I-12 在 #26 原子接线前不会静默忽略真实静态素材源", () => {
  const root = createBaselineRoot();
  try {
    mkdirSync(resolve(root, "static-public"));
    assert.throws(
      () => assertBaselineInputs(root),
      hasBuildCode("BUILD_PIPELINE_INCOMPLETE"),
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

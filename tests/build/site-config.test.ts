import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import test from "node:test";
import {readBuildContext} from "../../src/build/site-config/index.js";

test("E-012 合法 .js 公共入口可由 Node ESM 直接执行", () => {
  const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-build-"));
  const owner = "a".repeat(64);
  try {
    chmodSync(buildRoot, 0o700);
    mkdirSync(resolve(buildRoot, "static"), {mode: 0o700});
    writeFileSync(
      resolve(buildRoot, ".axial-muse-build-owner"),
      `${owner}\n`,
      {encoding: "utf8", mode: 0o600},
    );

    const context = readBuildContext({
      AXIAL_MUSE_BUILD_MODE: "production",
      AXIAL_MUSE_BUILD_ROOT: buildRoot,
      AXIAL_MUSE_BUILD_OWNER: owner,
    });
    assert.deepEqual(context, {
      mode: "production",
      staticDirectory: resolve(buildRoot, "static"),
    });
  } finally {
    rmSync(buildRoot, {recursive: true, force: true});
  }
});

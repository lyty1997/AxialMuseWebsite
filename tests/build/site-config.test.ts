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
import {
  readBuildContext,
  revalidateBuildContext,
} from "../../src/build/site-config/index.js";

test("E-012 合法 .js 公共入口可由 Node ESM 直接执行且完整封存上下文", () => {
  const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-build-"));
  const owner = "a".repeat(64);
  try {
    chmodSync(buildRoot, 0o700);
    mkdirSync(resolve(buildRoot, "static"), {mode: 0o700});
    writeFileSync(
      resolve(buildRoot, ".axial-muse-build-owner"),
      `production:${owner}\n`,
      {encoding: "utf8", mode: 0o600},
    );

    const context = readBuildContext({
      AXIAL_MUSE_BUILD_MODE: "production",
      AXIAL_MUSE_BUILD_ROOT: buildRoot,
      AXIAL_MUSE_BUILD_OWNER: owner,
    });
    assert.deepEqual(context, {
      mode: "production",
      buildRoot,
      staticDirectory: resolve(buildRoot, "static"),
      owner,
    });
    assert.ok(Object.isFrozen(context));
    assert.deepEqual(revalidateBuildContext(context), context);
  } finally {
    rmSync(buildRoot, {recursive: true, force: true});
  }
});

test("I-12 BuildContext 接受受控 preview，拒绝调用方伪造的静态目录", () => {
  const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-build-"));
  const owner = "b".repeat(64);
  try {
    chmodSync(buildRoot, 0o700);
    mkdirSync(resolve(buildRoot, "static"), {mode: 0o700});
    writeFileSync(
      resolve(buildRoot, ".axial-muse-build-owner"),
      `preview:${owner}\n`,
      {encoding: "utf8", mode: 0o600},
    );

    const context = readBuildContext({
      AXIAL_MUSE_BUILD_MODE: "preview",
      AXIAL_MUSE_BUILD_ROOT: buildRoot,
      AXIAL_MUSE_BUILD_OWNER: owner,
    });
    assert.equal(context.mode, "preview");
    assert.throws(
      () => revalidateBuildContext({...context, mode: "production"}),
      /\[BUILD_CONTEXT_MARKER\]/u,
    );
    assert.throws(
      () => revalidateBuildContext({
        ...context,
        staticDirectory: resolve(buildRoot, "elsewhere"),
      }),
      /\[BUILD_CONTEXT_STATIC_PATH\]/u,
    );
  } finally {
    rmSync(buildRoot, {recursive: true, force: true});
  }
});

test("I-12 BuildContext 缺少显式 mode 或 owner 时失败关闭", () => {
  const buildRoot = mkdtempSync(join(tmpdir(), "axial-muse-build-"));
  const owner = "c".repeat(64);
  try {
    chmodSync(buildRoot, 0o700);
    mkdirSync(resolve(buildRoot, "static"), {mode: 0o700});
    writeFileSync(
      resolve(buildRoot, ".axial-muse-build-owner"),
      `production:${owner}\n`,
      {encoding: "utf8", mode: 0o600},
    );
    assert.throws(
      () => readBuildContext({
        AXIAL_MUSE_BUILD_ROOT: buildRoot,
        AXIAL_MUSE_BUILD_OWNER: owner,
      }),
      /\[BUILD_CONTEXT_MODE\]/u,
    );
    assert.throws(
      () => readBuildContext({
        AXIAL_MUSE_BUILD_MODE: "production",
        AXIAL_MUSE_BUILD_ROOT: buildRoot,
      }),
      /\[BUILD_CONTEXT_ENV\]/u,
    );
  } finally {
    rmSync(buildRoot, {recursive: true, force: true});
  }
});

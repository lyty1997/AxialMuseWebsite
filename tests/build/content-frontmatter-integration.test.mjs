import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {
  ContentDecodeError,
  decodeFrontMatter,
} from "../../scripts/content/frontmatter.mjs";

const DECODER_PATH = fileURLToPath(new URL(
  "../../scripts/content/frontmatter.mjs",
  import.meta.url,
));

function assertDecodeError(error, code, sourcePath) {
  assert.ok(error instanceof ContentDecodeError);
  assert.equal(error.code, code);
  assert.equal(error.sourcePath, sourcePath);
  assert.ok(error.cause instanceof Error);
  assert.equal(error.stack, undefined);
  assert.equal(error.cause.stack, undefined);
  return true;
}

test("I-06 冻结默认解析器保留带引号日期并拒绝 timestamp", async () => {
  const filePath = "/private/work/site-content/writing/example/index.mdx";
  const sourcePath = "site-content/writing/example/index.mdx";
  const quoted = await decodeFrontMatter({
    fileContent: [
      "---",
      "publishedAt: \"2026-07-22\"",
      "metadata:",
      "  language: zh-CN",
      "---",
      "",
      "# 正文",
      "",
    ].join("\n"),
    filePath,
    sourcePath,
  });

  assert.equal(quoted.frontMatter.publishedAt, "2026-07-22");
  assert.deepEqual(quoted.frontMatter.metadata, {language: "zh-CN"});
  assert.ok(Object.isFrozen(quoted.frontMatter));
  assert.ok(Object.isFrozen(quoted.frontMatter.metadata));

  await assert.rejects(
    decodeFrontMatter({
      fileContent: [
        "---",
        "publishedAt: 2026-07-22",
        "---",
        "",
        "# 正文",
        "",
      ].join("\n"),
      filePath,
      sourcePath,
    }),
    (error) => assertDecodeError(
      error,
      "CONTENT_FRONTMATTER_SHAPE",
      sourcePath,
    ),
  );
});

test("I-06 独立解码器缺少冻结默认解析器时稳定失败关闭", () => {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-frontmatter-dependency-"));
  try {
    copyFileSync(DECODER_PATH, join(root, "frontmatter.mjs"));
    writeFileSync(
      join(root, "check.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import {registerHooks} from "node:module";',
        "registerHooks({",
        "  resolve(specifier, context, nextResolve) {",
        '    if (specifier === "@docusaurus/utils") {',
        '      throw new Error("blocked frozen parser");',
        "    }",
        "    return nextResolve(specifier, context);",
        "  },",
        "});",
        "const {ContentDecodeError, decodeFrontMatter} = await import(",
        '  "./frontmatter.mjs"',
        ");",
        'const sourcePath = "site-content/writing/example/index.mdx";',
        "await assert.rejects(",
        "  decodeFrontMatter({",
        '    fileContent: "---\\ntitle: example\\n---\\n",',
        '    filePath: "/private/work/example.mdx",',
        "    sourcePath,",
        "  }),",
        "  (error) => (",
        "    error instanceof ContentDecodeError",
        '    && error.code === "CONTENT_FRONTMATTER_DEPENDENCY"',
        "    && error.sourcePath === sourcePath",
        "    && error.cause instanceof Error",
        "    && error.stack === undefined",
        "    && error.cause.stack === undefined",
        "  ),",
        ");",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = spawnSync(process.execPath, [join(root, "check.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: {},
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(root, {force: true, recursive: true});
  }
});

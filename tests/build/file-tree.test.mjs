import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {
  captureFileTree,
  digestFileTreeRecords,
  FILE_TREE_MAX_DEPTH,
  FILE_TREE_MAX_DIRECTORIES,
  FILE_TREE_MAX_FILES,
  FILE_TREE_MAX_FILE_BYTES,
  FILE_TREE_MAX_TOTAL_BYTES,
  FILE_TREE_PATH_UNICODE_VERSION,
  FILE_TREE_WIRE_MAGIC,
  FileTreeError,
  fileTreeContentsEqual,
  fileTreeOperationallyEqual,
  fileTreeRootIdentityEqual,
  formatFileTreeError,
} from "../../scripts/quality/lib/file-tree.mjs";

const GOLDEN_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../ops/deploy/file-tree-v1-golden.json",
);

function hasCode(code) {
  return (error) => error instanceof FileTreeError && error.code === code;
}

function withTemporaryDirectory(callback) {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-file-tree-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

function writeFixture(root, relativePath, bytes) {
  const path = resolve(root, relativePath);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, bytes);
}

function recordsForVector(vector) {
  return vector.files.map((file) => {
    const bytes = Buffer.from(file.contentBase64, "base64");
    return {
      path: file.path,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

test("CODE-020 AXIALMUSE-FILE-TREE-V1 固定 golden vectors", () => {
  const fixture = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
  assert.equal(fixture.wireMagic, FILE_TREE_WIRE_MAGIC);
  assert.equal(
    fixture.pathUnicodeVersion,
    FILE_TREE_PATH_UNICODE_VERSION,
  );
  for (const vector of fixture.vectors) {
    assert.equal(
      digestFileTreeRecords(recordsForVector(vector)),
      vector.treeSha256,
      vector.name,
    );
  }
  assert.notEqual(
    fixture.vectors.find((entry) => entry.name === "single-byte-a").treeSha256,
    fixture.vectors.find((entry) => entry.name === "single-byte-b").treeSha256,
  );
  for (const vector of fixture.invalidVectors) {
    assert.throws(
      () => digestFileTreeRecords(vector.files.map((file) => {
        const content = Buffer.from(file.contentBase64, "base64");
        return {
          path: file.path,
          byteLength: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
        };
      })),
      hasCode("FILE_TREE_PATH"),
      vector.name,
    );
  }
});

test("CODE-020 文件系统枚举使用原始 UTF-8 bytes 排序且忽略空目录身份", () => {
  const fixture = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
  const vector = fixture.vectors.find(
    (entry) => entry.name === "raw-utf8-byte-order",
  );
  withTemporaryDirectory((root) => {
    for (const file of [...vector.files].reverse()) {
      writeFixture(root, file.path, Buffer.from(file.contentBase64, "base64"));
    }
    const before = captureFileTree({root, sourcePath: "fixture"});
    assert.deepEqual(
      before.records.map((record) => record.path),
      ["a.txt", "é.txt", ".txt", "𐀀.txt"],
    );
    assert.equal(before.treeSha256, vector.treeSha256);

    mkdirSync(resolve(root, "empty"));
    chmodSync(resolve(root, "a.txt"), 0o640);
    const after = captureFileTree({root, sourcePath: "fixture"});
    assert.equal(after.treeSha256, before.treeSha256);
    assert.equal(fileTreeContentsEqual(before, after), true);
    assert.equal(fileTreeOperationallyEqual(before, after), false);
  });
});

test("CODE-020 A→B→A 与同字节新 root inode 不得冒充未变化", () => {
  withTemporaryDirectory((parent) => {
    const root = resolve(parent, "tree");
    mkdirSync(root);
    writeFixture(root, "file.txt", "A");
    const before = captureFileTree({root, sourcePath: "fixture"});

    writeFileSync(resolve(root, "file.txt"), "B");
    writeFileSync(resolve(root, "file.txt"), "A");
    const restored = captureFileTree({root, sourcePath: "fixture"});
    assert.equal(fileTreeContentsEqual(before, restored), true);
    assert.equal(fileTreeOperationallyEqual(before, restored), false);

    const oldRoot = resolve(parent, "old-tree");
    renameSync(root, oldRoot);
    mkdirSync(root);
    writeFixture(root, "file.txt", "A");
    const replaced = captureFileTree({root, sourcePath: "fixture"});
    assert.equal(fileTreeContentsEqual(before, replaced), true);
    assert.equal(fileTreeRootIdentityEqual(before, replaced), false);
    assert.equal(fileTreeOperationallyEqual(before, replaced), false);
  });
});

test("CODE-020 枚举或读取期间的瞬时 mutation 失败关闭", () => {
  withTemporaryDirectory((root) => {
    writeFixture(root, "file.txt", "A");
    assert.throws(
      () => captureFileTree({
        root,
        sourcePath: "fixture",
        testHooks: {
          afterDirectoryRead({relativePath}) {
            if (relativePath === "") writeFixture(root, "late.txt", "late");
          },
        },
      }),
      hasCode("FILE_TREE_READ"),
    );
  });

  withTemporaryDirectory((root) => {
    writeFixture(root, "file.txt", "A");
    assert.throws(
      () => captureFileTree({
        root,
        sourcePath: "fixture",
        testHooks: {
          afterFileRead({relativePath}) {
            if (relativePath === "file.txt") {
              writeFileSync(resolve(root, relativePath), "B");
              writeFileSync(resolve(root, relativePath), "A");
            }
          },
        },
      }),
      hasCode("FILE_TREE_READ"),
    );
  });
});

test("CODE-020 路径、链接与特殊文件反例全部拒绝", async (t) => {
  const cases = [
    {
      name: "hidden segment",
      setup(root) {
        writeFixture(root, ".hidden/file.txt", "hidden");
      },
      code: "FILE_TREE_PATH",
    },
    {
      name: "case collision",
      setup(root) {
        writeFixture(root, "A.txt", "A");
        writeFixture(root, "a.txt", "a");
      },
      code: "FILE_TREE_PATH_COLLISION",
    },
    {
      name: "non-NFC",
      setup(root) {
        writeFixture(root, "e\u0301.txt", "accent");
      },
      code: "FILE_TREE_PATH",
    },
    {
      name: "backslash",
      setup(root) {
        writeFixture(root, String.raw`bad\name.txt`, "bad");
      },
      code: "FILE_TREE_PATH",
    },
    {
      name: "control character",
      setup(root) {
        writeFixture(root, "bad\nname.txt", "bad");
      },
      code: "FILE_TREE_PATH",
    },
    {
      name: "symlink",
      setup(root) {
        writeFixture(root, "target.txt", "target");
        symlinkSync(resolve(root, "target.txt"), resolve(root, "linked.txt"));
      },
      code: "FILE_TREE_ENTRY",
    },
  ];
  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, () => {
      withTemporaryDirectory((root) => {
        fixtureCase.setup(root);
        assert.throws(
          () => captureFileTree({root, sourcePath: "fixture"}),
          hasCode(fixtureCase.code),
        );
      });
    });
  }

  await t.test("external hardlink", () => {
    withTemporaryDirectory((parent) => {
      const root = resolve(parent, "tree");
      mkdirSync(root);
      writeFixture(parent, "outside.txt", "outside");
      linkSync(
        resolve(parent, "outside.txt"),
        resolve(root, "linked.txt"),
      );
      assert.throws(
        () => captureFileTree({root, sourcePath: "fixture"}),
        hasCode("FILE_TREE_ENTRY"),
      );
    });
  });

  await t.test("FIFO", () => {
    withTemporaryDirectory((root) => {
      const fifo = resolve(root, "pipe");
      const result = spawnSync("mkfifo", [fifo], {
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.throws(
        () => captureFileTree({root, sourcePath: "fixture"}),
        hasCode("FILE_TREE_ENTRY"),
      );
    });
  });
});

test("CODE-020 record API 拒绝 accessor 与不规范路径", () => {
  let getterCalls = 0;
  assert.throws(
    () => digestFileTreeRecords([{
      get path() {
        getterCalls += 1;
        return "file.txt";
      },
      byteLength: 0,
      sha256: "0".repeat(64),
    }]),
    hasCode("FILE_TREE_INPUT"),
  );
  assert.equal(getterCalls, 0);
  for (const path of [
    "/absolute",
    "../escape",
    "parent/../escape",
    ".hidden/file",
    "bad\\name",
    "e\u0301.txt",
    "\uD800.txt",
    "\uD801.txt",
  ]) {
    assert.throws(
      () => digestFileTreeRecords([{
        path,
        byteLength: 0,
        sha256: "0".repeat(64),
      }]),
      hasCode("FILE_TREE_PATH"),
      path,
    );
  }
});

test("CODE-020 record API 的文件数、深度、路径与字节边界精确失败关闭", () => {
  const sha256 = "0".repeat(64);
  const record = (path, byteLength = 0) => ({
    path,
    byteLength,
    sha256,
  });

  assert.match(
    digestFileTreeRecords([
      record(Array.from({length: FILE_TREE_MAX_DEPTH}, () => "a").join("/")),
    ]),
    /^[0-9a-f]{64}$/u,
  );
  assert.throws(
    () => digestFileTreeRecords([
      record(
        Array.from({length: FILE_TREE_MAX_DEPTH + 1}, () => "a").join("/"),
      ),
    ]),
    hasCode("FILE_TREE_PATH"),
  );

  assert.match(
    digestFileTreeRecords([record("a".repeat(255))]),
    /^[0-9a-f]{64}$/u,
  );
  assert.throws(
    () => digestFileTreeRecords([record("a".repeat(256))]),
    hasCode("FILE_TREE_PATH"),
  );

  const path4096 = [
    ...Array.from({length: 15}, () => "a".repeat(255)),
    "b".repeat(254),
    "c",
  ].join("/");
  const path4097 = [
    ...Array.from({length: 16}, () => "a".repeat(255)),
    "c",
  ].join("/");
  assert.equal(Buffer.byteLength(path4096), 4_096);
  assert.equal(Buffer.byteLength(path4097), 4_097);
  assert.match(
    digestFileTreeRecords([record(path4096)]),
    /^[0-9a-f]{64}$/u,
  );
  assert.throws(
    () => digestFileTreeRecords([record(path4097)]),
    hasCode("FILE_TREE_LIMIT"),
  );

  assert.match(
    digestFileTreeRecords([record("max.bin", FILE_TREE_MAX_FILE_BYTES)]),
    /^[0-9a-f]{64}$/u,
  );
  assert.throws(
    () => digestFileTreeRecords([
      record("too-large.bin", FILE_TREE_MAX_FILE_BYTES + 1),
    ]),
    hasCode("FILE_TREE_LIMIT"),
  );
  assert.match(
    digestFileTreeRecords(Array.from({length: 4}, (_, index) => (
      record(`total-${index}.bin`, FILE_TREE_MAX_FILE_BYTES)
    ))),
    /^[0-9a-f]{64}$/u,
  );
  assert.equal(FILE_TREE_MAX_TOTAL_BYTES, 4 * FILE_TREE_MAX_FILE_BYTES);
  assert.throws(
    () => digestFileTreeRecords([
      ...Array.from({length: 4}, (_, index) => (
        record(`total-${index}.bin`, FILE_TREE_MAX_FILE_BYTES)
      )),
      record("one-more.bin", 1),
    ]),
    hasCode("FILE_TREE_LIMIT"),
  );

  const maximumFiles = Array.from({length: FILE_TREE_MAX_FILES}, (_, index) => (
    record(`files/${index.toString(16).padStart(4, "0")}`)
  ));
  assert.match(
    digestFileTreeRecords(maximumFiles),
    /^[0-9a-f]{64}$/u,
  );
  assert.throws(
    () => digestFileTreeRecords([
      ...maximumFiles,
      record("files/overflow"),
    ]),
    hasCode("FILE_TREE_LIMIT"),
  );

  const maximumDirectoryRecords = [
    ...Array.from({length: 2_080}, (_, index) => record([
      `branch-${index.toString(16).padStart(4, "0")}`,
      ...Array.from({length: 62}, () => "a"),
      "file.txt",
    ].join("/"))),
    record([
      "limit",
      ...Array.from({length: 31}, () => "b"),
      "file.txt",
    ].join("/")),
  ];
  assert.equal(FILE_TREE_MAX_DIRECTORIES, 131_072);
  assert.match(
    digestFileTreeRecords(maximumDirectoryRecords),
    /^[0-9a-f]{64}$/u,
  );
  assert.throws(
    () => digestFileTreeRecords([
      ...maximumDirectoryRecords,
      record("overflow/file.txt"),
    ]),
    hasCode("FILE_TREE_LIMIT"),
  );
});

test("CODE-020 错误格式不泄漏绝对路径", () => {
  let caught;
  withTemporaryDirectory((root) => {
    writeFixture(root, ".hidden/file.txt", "hidden");
    try {
      captureFileTree({root, sourcePath: "fixture"});
    } catch (error) {
      caught = error;
    }
  });
  assert.ok(caught instanceof FileTreeError);
  assert.match(formatFileTreeError(caught), /^\[FILE_TREE_PATH\] /u);
  assert.doesNotMatch(formatFileTreeError(caught), /\/tmp\/|\/home\//u);
});

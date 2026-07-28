import assert from "node:assert/strict";
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
  assertNoAuthorTransactionResidue,
  AuthorTransactionStateError,
  findAuthorTransactionResidue,
  formatAuthorTransactionStateError,
} from "../../scripts/author/lib/transaction-state.mjs";
import {checkAuthorTransaction} from "../../scripts/quality/check-author-transaction.mjs";

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-author-state-"));
  mkdirSync(resolve(root, "site-content/writing"), {recursive: true});
  return root;
}

function expectResidue(root, sourcePath) {
  assert.throws(
    () => assertNoAuthorTransactionResidue({root}),
    (error) => (
      error instanceof AuthorTransactionStateError
      && error.code === "AUTHOR_TRANSACTION_RESIDUE"
      && error.sourcePath === sourcePath
    ),
  );
  assert.throws(
    () => checkAuthorTransaction({root}),
    (error) => (
      error instanceof AuthorTransactionStateError
      && error.code === "AUTHOR_TRANSACTION_RESIDUE"
    ),
  );
}

test("CODE-014 只读 residue checker 在无 lock/staging 的工作区通过", () => {
  const root = createFixture();
  try {
    assert.deepEqual(findAuthorTransactionResidue({root}), []);
    assert.doesNotThrow(() => assertNoAuthorTransactionResidue({root}));
    assert.deepEqual(checkAuthorTransaction({root}), {ok: true});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("CODE-014 residue checker 拒绝任意类型 lock 且不修改现场", () => {
  for (const kind of ["file", "directory", "symlink"]) {
    const root = createFixture();
    try {
      const lockPath = resolve(root, ".axial-muse-author.lock");
      if (kind === "file") writeFileSync(lockPath, "fixture\n");
      if (kind === "directory") mkdirSync(lockPath);
      if (kind === "symlink") symlinkSync("site-content", lockPath);
      assert.deepEqual(
        findAuthorTransactionResidue({root}),
        [".axial-muse-author.lock"],
      );
      expectResidue(root, ".axial-muse-author.lock");
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  }
});

test("CODE-014 residue checker 拒绝任意 staging 前缀成员并稳定排序", () => {
  const root = createFixture();
  try {
    writeFileSync(resolve(root, "site-content/.author-staging-z"), "fixture\n");
    mkdirSync(resolve(root, "site-content/.author-staging-a"));
    symlinkSync(
      "writing",
      resolve(root, "site-content/.author-staging-link"),
    );
    assert.deepEqual(findAuthorTransactionResidue({root}), [
      "site-content/.author-staging-a",
      "site-content/.author-staging-link",
      "site-content/.author-staging-z",
    ]);
    expectResidue(root, "site-content");
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("CODE-014 非规范 staging 名仍被阻断但不会注入公开诊断", () => {
  const root = createFixture();
  try {
    const maliciousName = ".author-staging-\nforged";
    writeFileSync(resolve(root, "site-content", maliciousName), "fixture\n");
    assert.throws(
      () => assertNoAuthorTransactionResidue({root}),
      (error) => {
        assert.equal(error.sourcePath, "site-content");
        const diagnostic = formatAuthorTransactionStateError(error);
        assert.equal(diagnostic.includes("forged"), false);
        assert.equal(diagnostic.includes("\n"), false);
        return true;
      },
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

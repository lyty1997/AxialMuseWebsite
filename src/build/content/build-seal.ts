import {createHash} from "node:crypto";
import type {Hash} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import type {BigIntStats} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, isAbsolute, resolve} from "node:path";
import {failContentBuild} from "./errors.js";

const TRANSACTION_ROOT_ENV = "AXIAL_MUSE_BUILD_TRANSACTION_ROOT";
const TRANSACTION_ROOT_PREFIX = "axial-muse-build-transaction-";
const TRANSACTION_OWNER_FILE = ".axial-muse-build-transaction-owner";
const INPUT_SEAL_FILE = ".axial-muse-content-input-seal";
const BUILD_LOCK_FILE = ".axial-muse-build.lock";
const OWNER_PATTERN = /^[0-9a-f]{64}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export type ContentSealPhase = "build" | "check" | "verify" | "release";

export interface ContentBuildSealController {
  readonly transactionRoot: string;
  write(): void;
  assert(): void;
}

function updateDigestFrame(hash: Hash, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

export function combineContentBuildInputDigests(
  contentDigest: string,
  staticAssetDigest: string,
): string {
  if (
    !DIGEST_PATTERN.test(contentDigest)
    || !DIGEST_PATTERN.test(staticAssetDigest)
  ) {
    failContentBuild("CONTENT_INPUT_DIGEST", "完整构建输入摘要字段不合法。", {
      sourcePath: "site-content",
    });
  }
  const hash = createHash("sha256");
  updateDigestFrame(hash, "axial-muse-complete-build-input-v1");
  updateDigestFrame(hash, "content-input-sha256");
  updateDigestFrame(hash, contentDigest);
  updateDigestFrame(hash, "static-asset-input-sha256");
  updateDigestFrame(hash, staticAssetDigest);
  return hash.digest("hex");
}

interface PrivateFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly linkCount: bigint;
  readonly owner: bigint;
  readonly group: bigint;
  readonly size: bigint;
  readonly modifiedAtNanoseconds: bigint;
  readonly changedAtNanoseconds: bigint;
}

function identityOf(value: BigIntStats): PrivateFileIdentity {
  return Object.freeze({
    device: value.dev,
    inode: value.ino,
    mode: value.mode,
    linkCount: value.nlink,
    owner: value.uid,
    group: value.gid,
    size: value.size,
    modifiedAtNanoseconds: value.mtimeNs,
    changedAtNanoseconds: value.ctimeNs,
  });
}

function sameIdentity(left: PrivateFileIdentity, right: PrivateFileIdentity): boolean {
  return Object.keys(left).every((key) => (
    left[key as keyof PrivateFileIdentity] === right[key as keyof PrivateFileIdentity]
  ));
}

function assertPrivateMetadata(
  value: BigIntStats,
  expectedType: "directory" | "file",
  expectedMode: bigint,
): void {
  const expectedTypeMatches = expectedType === "directory"
    ? value.isDirectory()
    : value.isFile();
  if (
    value.isSymbolicLink()
    || !expectedTypeMatches
    || (value.mode & 0o777n) !== expectedMode
    || (expectedType === "file" && value.nlink !== 1n)
    || (
      typeof process.getuid === "function"
      && value.uid !== BigInt(process.getuid())
    )
  ) {
    throw new TypeError("private build entry identity mismatch");
  }
}

function readStablePrivateFile(path: string): Readonly<{
  content: string;
  identity: PrivateFileIdentity;
}> {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const descriptorBefore = fstatSync(descriptor, {bigint: true});
    const pathBefore = lstatSync(path, {bigint: true});
    assertPrivateMetadata(descriptorBefore, "file", 0o600n);
    assertPrivateMetadata(pathBefore, "file", 0o600n);
    const beforeIdentity = identityOf(descriptorBefore);
    if (!sameIdentity(beforeIdentity, identityOf(pathBefore))) {
      throw new TypeError("private build entry path changed");
    }
    const bytes = readFileSync(descriptor);
    const descriptorAfter = fstatSync(descriptor, {bigint: true});
    const pathAfter = lstatSync(path, {bigint: true});
    if (
      !sameIdentity(beforeIdentity, identityOf(descriptorAfter))
      || !sameIdentity(beforeIdentity, identityOf(pathAfter))
      || BigInt(bytes.byteLength) !== beforeIdentity.size
    ) {
      throw new TypeError("private build entry changed while reading");
    }
    return Object.freeze({
      content: bytes.toString("utf8"),
      identity: beforeIdentity,
    });
  } finally {
    closeSync(descriptor);
  }
}

function readLockIdentity(repositoryRoot: string, owner: string): PrivateFileIdentity {
  const lockPath = resolve(repositoryRoot, BUILD_LOCK_FILE);
  try {
    const lock = readStablePrivateFile(lockPath);
    if (lock.content !== `${owner}\n`) {
      throw new TypeError("build lock owner mismatch");
    }
    return lock.identity;
  } catch (error) {
    failContentBuild("CONTENT_SESSION_LOCK", "内容构建 session 未绑定当前排他发布锁。", {
      cause: error,
      sourcePath: "build",
    });
  }
}

function expectedSeal(owner: string, inputDigest: string): string {
  return [
    "axial-muse-content-input-v1",
    `owner:${owner}`,
    `sha256:${inputDigest}`,
    "",
  ].join("\n");
}

function validateTransactionRoot(
  transactionRoot: string,
  mode: "production" | "preview",
  owner: string,
  expectSeal: boolean,
): Readonly<{
  rootIdentity: PrivateFileIdentity;
  markerIdentity: PrivateFileIdentity;
  seal?: Readonly<{content: string; identity: PrivateFileIdentity}>;
}> {
  try {
    const metadata = lstatSync(transactionRoot, {bigint: true});
    assertPrivateMetadata(metadata, "directory", 0o700n);
    const realRoot = realpathSync(transactionRoot);
    const temporaryRoot = realpathSync(tmpdir());
    if (
      realRoot !== transactionRoot
      || dirname(realRoot) !== temporaryRoot
      || !basename(realRoot).startsWith(TRANSACTION_ROOT_PREFIX)
    ) {
      throw new TypeError("transaction root path mismatch");
    }
    const expectedEntries = expectSeal
      ? [INPUT_SEAL_FILE, TRANSACTION_OWNER_FILE].sort()
      : [TRANSACTION_OWNER_FILE];
    const actualEntries = readdirSync(realRoot).sort();
    if (actualEntries.join("\n") !== expectedEntries.join("\n")) {
      throw new TypeError("transaction root member mismatch");
    }
    const marker = readStablePrivateFile(resolve(realRoot, TRANSACTION_OWNER_FILE));
    if (marker.content !== `${mode}:${owner}\n`) {
      throw new TypeError("transaction owner marker mismatch");
    }
    const seal = expectSeal
      ? readStablePrivateFile(resolve(realRoot, INPUT_SEAL_FILE))
      : undefined;
    return Object.freeze({
      rootIdentity: identityOf(metadata),
      markerIdentity: marker.identity,
      ...(seal === undefined ? {} : {seal}),
    });
  } catch (error) {
    failContentBuild(
      "CONTENT_SESSION_TRANSACTION",
      "内容构建 transaction 私有根身份或成员集合不合法。",
      {cause: error, sourcePath: "build"},
    );
  }
}

function sameRootIdentity(left: PrivateFileIdentity, right: PrivateFileIdentity): boolean {
  return (
    left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.linkCount === right.linkCount
    && left.owner === right.owner
    && left.group === right.group
  );
}

export function createContentBuildSealController(input: Readonly<{
  repositoryRoot: string;
  mode: "production" | "preview";
  owner: string;
  phase: ContentSealPhase;
  inputDigest: string;
  environment: NodeJS.ProcessEnv;
  assertInputsCurrent: () => void;
}>): ContentBuildSealController {
  const transactionRoot = input.environment[TRANSACTION_ROOT_ENV];
  if (
    typeof transactionRoot !== "string"
    || !isAbsolute(transactionRoot)
    || resolve(transactionRoot) !== transactionRoot
    || !OWNER_PATTERN.test(input.owner)
    || !DIGEST_PATTERN.test(input.inputDigest)
    || (input.mode !== "production" && input.mode !== "preview")
    || (
      input.phase !== "build"
      && input.phase !== "check"
      && input.phase !== "verify"
      && input.phase !== "release"
    )
    || typeof input.assertInputsCurrent !== "function"
  ) {
    failContentBuild("CONTENT_SESSION_TRANSACTION_ENV", "内容构建 transaction 环境不完整。", {
      sourcePath: "build",
    });
  }
  const sealPath = resolve(transactionRoot, INPUT_SEAL_FILE);
  const seal = expectedSeal(input.owner, input.inputDigest);
  const expectSeal = input.phase === "check" || input.phase === "verify";
  const lockIdentity = readLockIdentity(input.repositoryRoot, input.owner);
  const initialTransactionEvidence = validateTransactionRoot(
    transactionRoot,
    input.mode,
    input.owner,
    expectSeal,
  );
  let ownedSealIdentity = initialTransactionEvidence.seal?.identity;

  const assertControlIdentity = (
    currentExpectSeal: boolean,
  ): ReturnType<typeof validateTransactionRoot> => {
    const currentLockIdentity = readLockIdentity(input.repositoryRoot, input.owner);
    if (!sameIdentity(lockIdentity, currentLockIdentity)) {
      failContentBuild("CONTENT_SESSION_LOCK_IDENTITY", "内容构建 session 的排他锁身份已被替换。", {
        sourcePath: "build",
      });
    }
    const current = validateTransactionRoot(
      transactionRoot,
      input.mode,
      input.owner,
      currentExpectSeal,
    );
    if (
      !sameRootIdentity(
        initialTransactionEvidence.rootIdentity,
        current.rootIdentity,
      )
      || !sameIdentity(
        initialTransactionEvidence.markerIdentity,
        current.markerIdentity,
      )
      || (
        currentExpectSeal
        && ownedSealIdentity !== undefined
        && (
          current.seal === undefined
          || !sameIdentity(ownedSealIdentity, current.seal.identity)
        )
      )
    ) {
      failContentBuild(
        "CONTENT_SESSION_TRANSACTION_IDENTITY",
        "内容构建 transaction 根、owner marker 或 seal 身份已被替换。",
        {sourcePath: "build"},
      );
    }
    return current;
  };

  const assertSeal = (): void => {
    if (input.phase === "build") {
      failContentBuild("CONTENT_SEAL_PHASE", "build 阶段不得把既有输入 seal 当作验收结果。", {
        sourcePath: "build",
      });
    }
    input.assertInputsCurrent();
    const current = assertControlIdentity(true);
    try {
      if (current.seal?.content !== seal) {
        throw new TypeError("content input seal mismatch");
      }
    } catch (error) {
      failContentBuild("CONTENT_INPUT_SEAL", "当前完整内容输入与 build 阶段 seal 不一致。", {
        cause: error,
        sourcePath: "site-content",
      });
    }
  };

  const writeSeal = (): void => {
    if (input.phase !== "build" && input.phase !== "release") {
      failContentBuild("CONTENT_SEAL_PHASE", "只有 build postBuild 或 release 验证事务可以写入输入 seal。", {
        sourcePath: "build",
      });
    }
    input.assertInputsCurrent();
    assertControlIdentity(false);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        sealPath,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW,
        0o600,
      );
      chmodSync(sealPath, 0o600);
      writeFileSync(descriptor, seal, {encoding: "utf8"});
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      failContentBuild("CONTENT_INPUT_SEAL_WRITE", "build 输入 seal 未能唯一写入。", {
        cause: error,
        sourcePath: "build",
      });
    }
    const written = assertControlIdentity(true);
    try {
      if (written.seal?.content !== seal) {
        throw new TypeError("written content input seal mismatch");
      }
    } catch (error) {
      failContentBuild("CONTENT_INPUT_SEAL_WRITE", "build 输入 seal 写入后身份不稳定。", {
        cause: error,
        sourcePath: "build",
      });
    }
    ownedSealIdentity = written.seal.identity;
  };

  return Object.freeze({
    transactionRoot,
    write: writeSeal,
    assert: assertSeal,
  });
}

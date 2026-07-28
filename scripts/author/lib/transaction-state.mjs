import {
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {isAbsolute, relative, resolve} from "node:path";

export const AUTHOR_LOCK_FILE = ".axial-muse-author.lock";
export const AUTHOR_STAGING_PREFIX = ".author-staging-";

const SITE_CONTENT_PATH = "site-content";
const UNKNOWN_SOURCE_PATH = "site-content";
const AUTHOR_STAGING_SOURCE_PATTERN =
  /^site-content\/\.author-staging-[0-9a-f]{64}$/u;

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export class AuthorTransactionStateError extends Error {
  constructor(code, sourcePath = UNKNOWN_SOURCE_PATH, options) {
    super("作者事务状态检查失败。", options);
    this.name = "AuthorTransactionStateError";
    this.code = code;
    this.sourcePath = typeof sourcePath === "string"
      && (
        sourcePath === AUTHOR_LOCK_FILE
        || AUTHOR_STAGING_SOURCE_PATTERN.test(sourcePath)
      )
      ? sourcePath
      : UNKNOWN_SOURCE_PATH;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

function fail(code, sourcePath, cause) {
  throw new AuthorTransactionStateError(code, sourcePath, {cause});
}

function inspectRoot(root) {
  try {
    const lexicalRoot = resolve(root);
    const canonicalRoot = realpathSync(lexicalRoot);
    const metadata = lstatSync(canonicalRoot);
    if (
      lexicalRoot !== canonicalRoot
      || !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || (
        typeof process.getuid === "function"
        && metadata.uid !== process.getuid()
      )
    ) {
      fail("AUTHOR_TRANSACTION_ROOT", UNKNOWN_SOURCE_PATH);
    }
    return canonicalRoot;
  } catch (error) {
    if (error instanceof AuthorTransactionStateError) throw error;
    fail("AUTHOR_TRANSACTION_ROOT", UNKNOWN_SOURCE_PATH, error);
  }
}

export function findAuthorTransactionResidue({root = process.cwd()} = {}) {
  const canonicalRoot = inspectRoot(root);
  const residue = [];
  const lockPath = resolve(canonicalRoot, AUTHOR_LOCK_FILE);
  try {
    lstatSync(lockPath);
    residue.push(AUTHOR_LOCK_FILE);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      fail("AUTHOR_TRANSACTION_INSPECTION", AUTHOR_LOCK_FILE, error);
    }
  }

  const contentRoot = resolve(canonicalRoot, SITE_CONTENT_PATH);
  let contentMetadata;
  try {
    contentMetadata = lstatSync(contentRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze(residue);
    fail("AUTHOR_TRANSACTION_INSPECTION", UNKNOWN_SOURCE_PATH, error);
  }
  try {
    if (
      contentMetadata.isSymbolicLink()
      || !contentMetadata.isDirectory()
      || realpathSync(contentRoot) !== contentRoot
      || !isInside(canonicalRoot, contentRoot)
    ) {
      fail("AUTHOR_TRANSACTION_INSPECTION", UNKNOWN_SOURCE_PATH);
    }
  } catch (error) {
    if (error instanceof AuthorTransactionStateError) throw error;
    fail("AUTHOR_TRANSACTION_INSPECTION", UNKNOWN_SOURCE_PATH, error);
  }

  let entries;
  try {
    entries = readdirSync(contentRoot, {withFileTypes: true});
  } catch (error) {
    fail("AUTHOR_TRANSACTION_INSPECTION", UNKNOWN_SOURCE_PATH, error);
  }
  for (const entry of entries) {
    if (entry.name.startsWith(AUTHOR_STAGING_PREFIX)) {
      residue.push(`${SITE_CONTENT_PATH}/${entry.name}`);
    }
  }
  return Object.freeze(residue.sort(compareUtf8));
}

export function assertNoAuthorTransactionResidue(options) {
  const residue = findAuthorTransactionResidue(options);
  if (residue.length > 0) {
    fail("AUTHOR_TRANSACTION_RESIDUE", residue[0]);
  }
}

export function formatAuthorTransactionStateError(error) {
  const code = error instanceof AuthorTransactionStateError
    && /^AUTHOR_TRANSACTION_[A-Z0-9_]{1,96}$/u.test(error.code)
    ? error.code
    : "AUTHOR_TRANSACTION_INTERNAL";
  const sourcePath = error instanceof AuthorTransactionStateError
    ? error.sourcePath
    : UNKNOWN_SOURCE_PATH;
  return `[${code}] 作者事务存在活动 lock、残留 staging 或不可验证状态；source=${sourcePath}`;
}

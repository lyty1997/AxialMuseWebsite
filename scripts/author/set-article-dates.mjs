import {randomBytes} from "node:crypto";
import {spawnSync} from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {
  ArticleCreateError,
  acquireAuthorLock,
  assertAuthorLock,
  assertAuthorRuntime,
  assertNoBuildTransaction,
  assertNoForeignStaging,
  captureObjectIdentity,
  fileIdentity,
  formatArticleCreateError,
  inspectDirectory,
  inspectWorkspace,
  readStableFile,
  releaseAuthorLock,
  sameFileIdentity,
  sameObjectIdentity,
  syncDirectory,
} from "./create-article.mjs";
import {
  ArticleDateEditError,
  formatShanghaiDate,
  planArticleDateEdit,
} from "./lib/article-date-edit.mjs";
import {
  assertNoAuthorTransactionResidue,
  AUTHOR_LOCK_FILE,
  AUTHOR_STAGING_PREFIX,
  AuthorTransactionStateError,
  formatAuthorTransactionStateError,
} from "./lib/transaction-state.mjs";
import {
  ContentDecodeError,
  decodeFrontMatter,
} from "../content/frontmatter.mjs";
import {
  buildContentHistoryGitEnvironment,
  checkArticleDateHistoryCandidate,
  checkContentHistory,
  ContentHistoryError,
  formatContentHistoryError,
} from "../quality/lib/content-history.mjs";

const SOURCE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const OWNER_PATTERN = /^[0-9a-f]{64}$/u;
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_SOURCE_PATH_PATTERN =
  /^site-content\/writing\/[a-z0-9]+(?:-[a-z0-9]+)*\/index\.(?:md|mdx)$/u;
const MAX_ARTICLE_BYTES = 4 * 1024 * 1024;
const SINGLE_FLAGS = Object.freeze(["--source-name", "--action"]);
const ALL_FLAGS = new Set(SINGLE_FLAGS);
const AUTOMATION_KEYS = Object.freeze([
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_JOB",
  "GITHUB_WORKFLOW",
  "RUNNER_OS",
]);
const TEST_HOOK_NAMES = new Set([
  "afterLockAcquired",
  "afterSourceReplace",
  "beforeArticleDirectoryFlush",
  "beforeCandidateWrite",
  "beforeFileFlush",
  "beforeFinalHistoryCheck",
  "beforeLockRelease",
  "beforeOriginalWrite",
  "beforeRollback",
  "beforeRollbackReplace",
  "beforeSourceReplace",
  "beforeStagingCleanup",
  "beforeStagingDirectoryFlush",
]);
const ERROR_SUMMARIES = Object.freeze({
  AUTHOR_DATE_ARGUMENTS: "作者日期命令参数不合法。",
  AUTHOR_DATE_AUTOMATION: "作者日期命令不得由自动化环境触发。",
  AUTHOR_DATE_CLOCK: "文章日期时钟无法产生合法的上海日期。",
  AUTHOR_DATE_CONTENT: "文章日期候选未通过终态内容校验。",
  AUTHOR_DATE_DRIFT: "文章日期源在事务期间发生漂移。",
  AUTHOR_DATE_INTERNAL: "作者日期命令发生未分类错误。",
  AUTHOR_DATE_SOURCE: "文章日期源无法安全定点编辑。",
  AUTHOR_DATE_STATE: "文章状态不允许执行该日期操作。",
  AUTHOR_DATE_TARGET: "目标文章正文入口不存在或不唯一。",
});
const DEFAULT_DEPENDENCIES = Object.freeze({
  checkHistory: checkContentHistory,
  checkHistoryCandidate: checkArticleDateHistoryCandidate,
  createOwner: () => randomBytes(32).toString("hex"),
  decodeArticle: decodeFrontMatter,
  flushDirectory: syncDirectory,
  flushFile: (descriptor) => fsyncSync(descriptor),
  nowMilliseconds: () => Date.now(),
  readHead: (root) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "core.commitGraph=false",
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: buildContentHistoryGitEnvironment(),
        windowsHide: true,
      },
    );
    const head = result?.stdout?.trim();
    if (
      result?.error
      || result?.status !== 0
      || (result?.signal !== null && result?.signal !== undefined)
      || typeof head !== "string"
      || !OBJECT_ID_PATTERN.test(head)
      || result.stdout !== `${head}\n`
    ) {
      throw new TypeError("unable to read stable HEAD");
    }
    return head;
  },
  releaseLockBoundary: () => {},
  renameFile: (source, target) => renameSync(source, target),
  writeManagedFile: (descriptor, fileContent) => {
    writeFileSync(descriptor, fileContent, {encoding: "utf8"});
  },
});
const UTF8_DECODER = new TextDecoder("utf-8", {fatal: true});
const UTF8_ENCODER = new TextEncoder();

function isPlainRecord(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function safeField(value) {
  return ALL_FLAGS.has(value) ? value : "arguments";
}

function safeSourcePath(value) {
  return typeof value === "string" && SAFE_SOURCE_PATH_PATTERN.test(value)
    ? value
    : "site-content/writing";
}

export class SetArticleDatesError extends Error {
  constructor(code, {
    cause,
    field = "arguments",
    sourcePath = "site-content/writing",
  } = {}) {
    const stableCode = Object.hasOwn(ERROR_SUMMARIES, code)
      ? code
      : "AUTHOR_DATE_INTERNAL";
    super(ERROR_SUMMARIES[stableCode], {cause});
    this.name = "SetArticleDatesError";
    this.code = stableCode;
    this.field = safeField(field);
    this.sourcePath = safeSourcePath(sourcePath);
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

function fail(code, details) {
  throw new SetArticleDatesError(code, details);
}

function failShared(code, details) {
  throw new ArticleCreateError(code, details);
}

export function parseSetArticleDatesArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length !== 4) {
    fail("AUTHOR_DATE_ARGUMENTS");
  }
  const values = new Map();
  try {
    for (let index = 0; index < arguments_.length; index += 2) {
      const flag = arguments_[index];
      const value = arguments_[index + 1];
      if (
        typeof flag !== "string"
        || !ALL_FLAGS.has(flag)
        || flag.includes("=")
        || typeof value !== "string"
        || values.has(flag)
      ) {
        fail("AUTHOR_DATE_ARGUMENTS", {
          field: typeof flag === "string" ? flag : "arguments",
        });
      }
      values.set(flag, value);
    }
  } catch (error) {
    if (error instanceof SetArticleDatesError) throw error;
    fail("AUTHOR_DATE_ARGUMENTS");
  }

  const sourceName = values.get("--source-name");
  const action = values.get("--action");
  if (
    typeof sourceName !== "string"
    || sourceName.length > 64
    || !SOURCE_NAME_PATTERN.test(sourceName)
  ) {
    fail("AUTHOR_DATE_ARGUMENTS", {field: "--source-name"});
  }
  if (action !== "publish" && action !== "revise") {
    fail("AUTHOR_DATE_ARGUMENTS", {field: "--action"});
  }
  return Object.freeze({action, sourceName});
}

function validateDependencies(value) {
  if (value === undefined) return DEFAULT_DEPENDENCIES;
  if (!isPlainRecord(value)) fail("AUTHOR_DATE_INTERNAL");
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail("AUTHOR_DATE_INTERNAL");
  }
  const allowed = new Set(Object.keys(DEFAULT_DEPENDENCIES));
  if (
    Reflect.ownKeys(descriptors).some((key) => (
      typeof key !== "string"
      || !allowed.has(key)
      || !Object.hasOwn(descriptors[key], "value")
      || !descriptors[key].enumerable
      || typeof descriptors[key].value !== "function"
    ))
  ) {
    fail("AUTHOR_DATE_INTERNAL");
  }
  return Object.freeze({
    ...DEFAULT_DEPENDENCIES,
    ...Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => (
        [key, descriptor.value]
      )),
    ),
  });
}

function validateTestHooks(value) {
  if (value === undefined) return Object.freeze({});
  if (!isPlainRecord(value)) fail("AUTHOR_DATE_INTERNAL");
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail("AUTHOR_DATE_INTERNAL");
  }
  if (
    Reflect.ownKeys(descriptors).some((key) => (
      typeof key !== "string"
      || !TEST_HOOK_NAMES.has(key)
      || !Object.hasOwn(descriptors[key], "value")
      || !descriptors[key].enumerable
      || typeof descriptors[key].value !== "function"
    ))
  ) {
    fail("AUTHOR_DATE_INTERNAL");
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => (
      [key, descriptor.value]
    )),
  ));
}

function invokeHook(hooks, name, code, details, {shared = false} = {}) {
  try {
    hooks[name]?.();
  } catch (cause) {
    if (shared) failShared(code, {...details, cause});
    fail(code, {...details, cause});
  }
}

function assertManualAuthorEnvironment(environment) {
  try {
    if (
      environment === null
      || typeof environment !== "object"
      || Array.isArray(environment)
    ) {
      fail("AUTHOR_DATE_AUTOMATION");
    }
    for (const key of AUTOMATION_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(environment, key);
      if (descriptor === undefined) continue;
      if (
        !Object.hasOwn(descriptor, "value")
        || (
          descriptor.value !== undefined
          && typeof descriptor.value !== "string"
        )
      ) {
        fail("AUTHOR_DATE_AUTOMATION");
      }
      const value = descriptor.value;
      if (
        typeof value === "string"
        && value !== ""
        && value.toLowerCase() !== "false"
      ) {
        fail("AUTHOR_DATE_AUTOMATION");
      }
    }
  } catch (error) {
    if (error instanceof SetArticleDatesError) throw error;
    fail("AUTHOR_DATE_AUTOMATION");
  }
}

function decodeUtf8(bytes, sourcePath) {
  if (
    !Buffer.isBuffer(bytes)
    || bytes.byteLength === 0
    || bytes.byteLength > MAX_ARTICLE_BYTES
  ) {
    fail("AUTHOR_DATE_SOURCE", {sourcePath});
  }
  try {
    const fileContent = UTF8_DECODER.decode(bytes);
    if (!Buffer.from(UTF8_ENCODER.encode(fileContent)).equals(bytes)) {
      fail("AUTHOR_DATE_SOURCE", {sourcePath});
    }
    return fileContent;
  } catch (error) {
    if (error instanceof SetArticleDatesError) throw error;
    fail("AUTHOR_DATE_SOURCE", {cause: error, sourcePath});
  }
}

function inspectArticleTarget(workspace, sourceName) {
  const articleDirectoryPath = resolve(workspace.writing.path, sourceName);
  const directorySourcePath = `site-content/writing/${sourceName}`;
  let articleDirectory;
  let names;
  try {
    articleDirectory = inspectDirectory(
      articleDirectoryPath,
      directorySourcePath,
    );
    if (articleDirectory.identity.device !== workspace.writing.identity.device) {
      throw new TypeError("article directory crossed filesystem boundary");
    }
    names = readdirSync(articleDirectoryPath, {withFileTypes: true});
  } catch (cause) {
    if (cause instanceof ArticleCreateError) {
      fail("AUTHOR_DATE_TARGET", {cause, sourcePath: directorySourcePath});
    }
    fail("AUTHOR_DATE_TARGET", {cause, sourcePath: directorySourcePath});
  }

  const entryNames = names
    .filter((entry) => (
      entry.name === "index.md" || entry.name === "index.mdx"
    ))
    .map((entry) => entry.name);
  if (entryNames.length !== 1) {
    fail("AUTHOR_DATE_TARGET", {sourcePath: directorySourcePath});
  }
  const entryName = entryNames[0];
  const sourcePath = `${directorySourcePath}/${entryName}`;
  const targetPath = resolve(articleDirectoryPath, entryName);
  let snapshot;
  try {
    snapshot = readStableFile(targetPath, sourcePath, "AUTHOR_WORKTREE");
  } catch (cause) {
    fail("AUTHOR_DATE_TARGET", {cause, sourcePath});
  }
  if (snapshot.bytes.byteLength > MAX_ARTICLE_BYTES) {
    fail("AUTHOR_DATE_SOURCE", {sourcePath});
  }
  return Object.freeze({
    articleDirectory,
    articleDirectoryPath,
    entryName,
    snapshot,
    sourcePath,
    targetPath,
  });
}

function sameTarget(left, right) {
  return left.sourcePath === right.sourcePath
    && left.targetPath === right.targetPath
    && sameObjectIdentity(
      left.articleDirectory.identity,
      right.articleDirectory.identity,
    )
    && sameFileIdentity(left.snapshot.identity, right.snapshot.identity)
    && left.snapshot.bytes.equals(right.snapshot.bytes);
}

function assertTargetUnchanged(workspace, sourceName, expected) {
  let current;
  try {
    current = inspectArticleTarget(workspace, sourceName);
  } catch (cause) {
    fail("AUTHOR_DATE_DRIFT", {
      cause,
      sourcePath: expected.sourcePath,
    });
  }
  if (!sameTarget(expected, current)) {
    fail("AUTHOR_DATE_DRIFT", {sourcePath: expected.sourcePath});
  }
  return current;
}

async function decodeArticleSnapshot(target, dependencies) {
  const fileContent = decodeUtf8(target.snapshot.bytes, target.sourcePath);
  try {
    const decoded = await dependencies.decodeArticle({
      fileContent,
      filePath: target.targetPath,
      sourcePath: target.sourcePath,
    });
    return Object.freeze({decoded, fileContent});
  } catch (cause) {
    fail("AUTHOR_DATE_SOURCE", {
      cause,
      sourcePath: target.sourcePath,
    });
  }
}

function withoutDates(frontMatter) {
  if (!isPlainRecord(frontMatter)) fail("AUTHOR_DATE_CONTENT");
  const value = {};
  for (const [key, fieldValue] of Object.entries(frontMatter)) {
    if (key !== "publishedAt" && key !== "updatedAt") {
      value[key] = fieldValue;
    }
  }
  return value;
}

async function assertCandidateRoundTrip({
  dependencies,
  originalDecoded,
  plan,
  target,
}) {
  let candidateDecoded;
  try {
    candidateDecoded = await dependencies.decodeArticle({
      fileContent: plan.fileContent,
      filePath: target.targetPath,
      sourcePath: target.sourcePath,
    });
    const candidateFrontMatter = candidateDecoded?.frontMatter;
    const originalFrontMatter = originalDecoded?.frontMatter;
    if (
      !isPlainRecord(candidateFrontMatter)
      || !isPlainRecord(originalFrontMatter)
      || candidateDecoded.content !== originalDecoded.content
      || candidateFrontMatter.articleId !== plan.articleId
      || candidateFrontMatter.publicationStatus !== "published"
      || candidateFrontMatter.publishedAt !== plan.publishedAt
      || candidateFrontMatter.updatedAt !== plan.updatedAt
      || JSON.stringify(withoutDates(candidateFrontMatter))
        !== JSON.stringify(withoutDates(originalFrontMatter))
    ) {
      fail("AUTHOR_DATE_CONTENT", {sourcePath: target.sourcePath});
    }
  } catch (cause) {
    if (cause instanceof SetArticleDatesError) throw cause;
    fail("AUTHOR_DATE_CONTENT", {
      cause,
      sourcePath: target.sourcePath,
    });
  }
}

function writeStagingFile({
  dependencies,
  fileContent,
  hooks,
  hookName,
  mode,
  onCreated,
  path,
  sourcePath,
}) {
  let descriptor;
  let operationError;
  let result;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    onCreated(fileIdentity(fstatSync(descriptor, {bigint: true})));
    invokeHook(
      hooks,
      hookName,
      "AUTHOR_WRITE",
      {sourcePath},
      {shared: true},
    );
    dependencies.writeManagedFile(descriptor, fileContent);
    fchmodSync(descriptor, mode);
    invokeHook(
      hooks,
      "beforeFileFlush",
      "AUTHOR_FILE_FLUSH",
      {sourcePath},
      {shared: true},
    );
    dependencies.flushFile(descriptor);
    result = fileIdentity(fstatSync(descriptor, {bigint: true}));
    onCreated(result);
  } catch (error) {
    operationError = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (cause) {
        operationError = operationError === undefined
          ? cause
          : new AggregateError(
              [operationError, cause],
              "staging file write and close both failed",
            );
      }
    }
  }
  if (operationError !== undefined) {
    if (operationError instanceof ArticleCreateError) throw operationError;
    failShared("AUTHOR_WRITE", {cause: operationError, sourcePath});
  }
  return result;
}

function createStaging(transaction, workspace, hooks, dependencies) {
  try {
    mkdirSync(transaction.stagingPath, {mode: 0o700});
    transaction.stagingPresent = true;
    transaction.stagingIdentity = captureObjectIdentity(
      transaction.stagingPath,
      "directory",
    );
    chmodSync(transaction.stagingPath, 0o700);
    const restrictedIdentity = captureObjectIdentity(
      transaction.stagingPath,
      "directory",
    );
    if (
      !sameObjectIdentity(
        transaction.stagingIdentity,
        restrictedIdentity,
      )
      || (restrictedIdentity.mode & 0o7777n) !== 0o700n
    ) {
      throw new TypeError("staging directory mode or identity mismatch");
    }
    transaction.stagingIdentity = restrictedIdentity;
  } catch (cause) {
    failShared("AUTHOR_STAGING", {
      cause,
      sourcePath: transaction.sourcePath,
    });
  }

  transaction.originalIdentity = writeStagingFile({
    dependencies,
    fileContent: transaction.originalFileContent,
    hooks,
    hookName: "beforeOriginalWrite",
    mode: transaction.originalMode,
    onCreated(identity) {
      transaction.originalIdentity = identity;
      transaction.originalInStaging = true;
    },
    path: transaction.originalPath,
    sourcePath: transaction.sourcePath,
  });
  transaction.candidateIdentity = writeStagingFile({
    dependencies,
    fileContent: transaction.candidateFileContent,
    hooks,
    hookName: "beforeCandidateWrite",
    mode: transaction.originalMode,
    onCreated(identity) {
      transaction.candidateIdentity = identity;
      transaction.candidateInStaging = true;
    },
    path: transaction.candidatePath,
    sourcePath: transaction.sourcePath,
  });
  try {
    invokeHook(
      hooks,
      "beforeStagingDirectoryFlush",
      "AUTHOR_DIRECTORY_FLUSH",
      {sourcePath: transaction.sourcePath},
      {shared: true},
    );
    dependencies.flushDirectory(transaction.stagingPath);
    dependencies.flushDirectory(workspace.content.path);
  } catch (error) {
    if (error instanceof ArticleCreateError) throw error;
    failShared("AUTHOR_DIRECTORY_FLUSH", {
      cause: error,
      sourcePath: transaction.sourcePath,
    });
  }
}

function assertCandidateTarget(transaction, workspace) {
  let current;
  try {
    current = inspectArticleTarget(workspace, transaction.input.sourceName);
  } catch (cause) {
    fail("AUTHOR_DATE_DRIFT", {
      cause,
      sourcePath: transaction.sourcePath,
    });
  }
  if (
    current.sourcePath !== transaction.sourcePath
    || !sameObjectIdentity(
      current.articleDirectory.identity,
      transaction.articleDirectoryIdentity,
    )
    || transaction.candidateIdentity === undefined
    || !(
      transaction.candidateIdentityBound
        ? sameFileIdentity(
            current.snapshot.identity,
            transaction.candidateIdentity,
          )
        : sameObjectIdentity(
            current.snapshot.identity,
            transaction.candidateIdentity,
          )
          && (current.snapshot.identity.mode & 0o7777n)
            === BigInt(transaction.originalMode)
          && current.snapshot.identity.size
            === transaction.candidateIdentity.size
    )
    || !current.snapshot.bytes.equals(transaction.candidateBytes)
  ) {
    fail("AUTHOR_DATE_DRIFT", {sourcePath: transaction.sourcePath});
  }
  if (!transaction.candidateIdentityBound) {
    transaction.candidateIdentity = current.snapshot.identity;
    transaction.candidateIdentityBound = true;
  }
  return current;
}

function activateCandidate(transaction, workspace, hooks, dependencies) {
  assertTargetUnchanged(
    workspace,
    transaction.input.sourceName,
    transaction.originalTarget,
  );
  assertNoBuildTransaction(workspace);
  assertAuthorLock(transaction.lock);
  invokeHook(
    hooks,
    "beforeSourceReplace",
    "AUTHOR_RENAME",
    {sourcePath: transaction.sourcePath},
    {shared: true},
  );
  assertTargetUnchanged(
    workspace,
    transaction.input.sourceName,
    transaction.originalTarget,
  );
  assertNoBuildTransaction(workspace);
  assertAuthorLock(transaction.lock);
  try {
    dependencies.renameFile(
      transaction.candidatePath,
      transaction.originalTarget.targetPath,
    );
    transaction.candidateInStaging = false;
    transaction.candidateAtTarget = true;
    transaction.candidateWasActivated = true;
  } catch (cause) {
    try {
      const current = inspectArticleTarget(
        workspace,
        transaction.input.sourceName,
      );
      if (
        transaction.candidateIdentity !== undefined
        && sameObjectIdentity(
          current.snapshot.identity,
          transaction.candidateIdentity,
        )
        && current.snapshot.bytes.equals(transaction.candidateBytes)
      ) {
        transaction.candidateInStaging = false;
        transaction.candidateAtTarget = true;
        transaction.candidateWasActivated = true;
        transaction.candidateIdentity = current.snapshot.identity;
        transaction.candidateIdentityBound = true;
      }
    } catch {
      // rename 结果无法证明时交给所有权感知 rollback 保留现场。
    }
    failShared("AUTHOR_RENAME", {
      cause,
      sourcePath: transaction.sourcePath,
    });
  }
  invokeHook(
    hooks,
    "afterSourceReplace",
    "AUTHOR_DATE_CONTENT",
    {sourcePath: transaction.sourcePath},
  );
  try {
    dependencies.flushDirectory(transaction.stagingPath);
    invokeHook(
      hooks,
      "beforeArticleDirectoryFlush",
      "AUTHOR_DIRECTORY_FLUSH",
      {sourcePath: transaction.sourcePath},
      {shared: true},
    );
    dependencies.flushDirectory(
      transaction.originalTarget.articleDirectoryPath,
    );
  } catch (error) {
    if (error instanceof ArticleCreateError) throw error;
    failShared("AUTHOR_DIRECTORY_FLUSH", {
      cause: error,
      sourcePath: transaction.sourcePath,
    });
  }
  assertCandidateTarget(transaction, workspace);
}

function inspectStaging(transaction) {
  const identity = captureObjectIdentity(transaction.stagingPath, "directory");
  if (
    transaction.stagingIdentity === undefined
    || !sameObjectIdentity(transaction.stagingIdentity, identity)
    || (identity.mode & 0o7777n) !== 0o700n
  ) {
    throw new TypeError("staging directory identity mismatch");
  }
  const names = readdirSync(transaction.stagingPath).sort();
  const expected = [
    ...(transaction.candidateInStaging ? ["candidate"] : []),
    ...(transaction.originalInStaging ? ["original"] : []),
  ].sort();
  if (
    names.length !== expected.length
    || names.some((name, index) => name !== expected[index])
  ) {
    throw new TypeError("staging directory member mismatch");
  }
}

function removeStagingFile(transaction, name) {
  const path = name === "candidate"
    ? transaction.candidatePath
    : transaction.originalPath;
  const expected = name === "candidate"
    ? transaction.candidateIdentity
    : transaction.originalIdentity;
  const identity = captureObjectIdentity(path, "file");
  if (
    expected === undefined
    || !sameObjectIdentity(expected, identity)
  ) {
    throw new TypeError("staging file identity mismatch");
  }
  unlinkSync(path);
  if (name === "candidate") transaction.candidateInStaging = false;
  else transaction.originalInStaging = false;
}

function cleanupOwnedStaging(transaction, workspace, dependencies) {
  inspectStaging(transaction);
  if (transaction.candidateInStaging) {
    removeStagingFile(transaction, "candidate");
  }
  if (transaction.originalInStaging) {
    removeStagingFile(transaction, "original");
  }
  dependencies.flushDirectory(transaction.stagingPath);
  inspectStaging(transaction);
  rmdirSync(transaction.stagingPath);
  transaction.stagingPresent = false;
  dependencies.flushDirectory(workspace.content.path);
}

function createRollbackOriginal(
  transaction,
  workspace,
  hooks,
  dependencies,
) {
  if (!transaction.stagingPresent) {
    mkdirSync(transaction.stagingPath, {mode: 0o700});
    transaction.stagingPresent = true;
    chmodSync(transaction.stagingPath, 0o700);
    transaction.stagingIdentity = captureObjectIdentity(
      transaction.stagingPath,
      "directory",
    );
    if ((transaction.stagingIdentity.mode & 0o7777n) !== 0o700n) {
      throw new TypeError("rollback staging directory mode mismatch");
    }
  } else {
    inspectStaging(transaction);
  }
  if (!transaction.originalInStaging) {
    transaction.originalIdentity = writeStagingFile({
      dependencies,
      fileContent: transaction.originalFileContent,
      hooks,
      hookName: "beforeOriginalWrite",
      mode: transaction.originalMode,
      onCreated(identity) {
        transaction.originalIdentity = identity;
        transaction.originalInStaging = true;
      },
      path: transaction.originalPath,
      sourcePath: transaction.sourcePath,
    });
  }
  dependencies.flushDirectory(transaction.stagingPath);
  dependencies.flushDirectory(workspace.content.path);
  assertRollbackOriginal(transaction);
}

function assertRollbackOriginal(transaction) {
  const snapshot = readStableFile(
    transaction.originalPath,
    transaction.sourcePath,
    "AUTHOR_WORKTREE",
  );
  if (
    transaction.originalIdentity === undefined
    || !sameFileIdentity(transaction.originalIdentity, snapshot.identity)
    || !snapshot.bytes.equals(transaction.originalBytes)
    || (snapshot.identity.mode & 0o7777n)
      !== BigInt(transaction.originalMode)
  ) {
    throw new TypeError("rollback original identity or bytes mismatch");
  }
}

function assertRestoredTarget(transaction, workspace) {
  const restored = inspectArticleTarget(
    workspace,
    transaction.input.sourceName,
  );
  const identityMatches = transaction.restoredIdentity === undefined
    ? (
        transaction.originalIdentity !== undefined
        && sameObjectIdentity(
          restored.snapshot.identity,
          transaction.originalIdentity,
        )
      )
    : sameFileIdentity(
        restored.snapshot.identity,
        transaction.restoredIdentity,
      );
  if (
    !sameObjectIdentity(
      restored.articleDirectory.identity,
      transaction.articleDirectoryIdentity,
    )
    || !identityMatches
    || !restored.snapshot.bytes.equals(transaction.originalBytes)
    || (restored.snapshot.identity.mode & 0o7777n)
      !== BigInt(transaction.originalMode)
  ) {
    throw new TypeError("restored article bytes or mode mismatch");
  }
  if (transaction.restoredIdentity === undefined) {
    transaction.restoredIdentity = restored.snapshot.identity;
  }
  return restored;
}

function releasePreflightLock(transaction, workspace, dependencies) {
  releaseAuthorLock(transaction.lock, {
    releaseLockBoundary(lock) {
      dependencies.releaseLockBoundary(lock);
      assertTargetUnchanged(
        workspace,
        transaction.input.sourceName,
        transaction.originalTarget,
      );
      assertAuthorLock(lock);
    },
  });
}

function releaseRollbackLock(transaction, workspace, dependencies) {
  releaseAuthorLock(transaction.lock, {
    releaseLockBoundary(lock) {
      dependencies.releaseLockBoundary(lock);
      if (transaction.candidateWasActivated) {
        assertRestoredTarget(transaction, workspace);
      } else {
        assertTargetUnchanged(
          workspace,
          transaction.input.sourceName,
          transaction.originalTarget,
        );
      }
      assertNoBuildTransaction(workspace);
      assertAuthorLock(lock);
    },
  });
}

function rollbackTransaction(transaction, workspace, hooks, dependencies) {
  const errors = [];
  if (transaction.candidateAtTarget) {
    try {
      invokeHook(
        hooks,
        "beforeRollback",
        "AUTHOR_ROLLBACK",
        {sourcePath: transaction.sourcePath},
        {shared: true},
      );
      assertCandidateTarget(transaction, workspace);
      createRollbackOriginal(
        transaction,
        workspace,
        hooks,
        dependencies,
      );
      invokeHook(
        hooks,
        "beforeRollbackReplace",
        "AUTHOR_ROLLBACK",
        {sourcePath: transaction.sourcePath},
        {shared: true},
      );
      assertCandidateTarget(transaction, workspace);
      assertRollbackOriginal(transaction);
      assertNoBuildTransaction(workspace);
      assertAuthorLock(transaction.lock);
      dependencies.renameFile(
        transaction.originalPath,
        transaction.originalTarget.targetPath,
      );
      transaction.originalInStaging = false;
      transaction.candidateAtTarget = false;
    } catch (error) {
      try {
        const restored = assertRestoredTarget(transaction, workspace);
        if (
          transaction.originalIdentity !== undefined
          && sameObjectIdentity(
            restored.snapshot.identity,
            transaction.originalIdentity,
          )
        ) {
          transaction.originalInStaging = false;
          transaction.candidateAtTarget = false;
        } else {
          throw error;
        }
      } catch {
        errors.push(error);
      }
    }
    if (!transaction.candidateAtTarget) {
      try {
        dependencies.flushDirectory(
          transaction.originalTarget.articleDirectoryPath,
        );
        dependencies.flushDirectory(transaction.stagingPath);
        assertRestoredTarget(transaction, workspace);
      } catch (error) {
        errors.push(error);
      }
    }
  }

  if (
    errors.length === 0
    && !transaction.candidateAtTarget
    && transaction.stagingPresent
  ) {
    try {
      cleanupOwnedStaging(transaction, workspace, dependencies);
    } catch (error) {
      errors.push(error);
    }
  }
  if (
    errors.length === 0
    && transaction.lock !== undefined
    && !transaction.lock.unlinked
  ) {
    try {
      if (transaction.originalBytes === undefined) {
        releasePreflightLock(transaction, workspace, dependencies);
      } else {
        releaseRollbackLock(transaction, workspace, dependencies);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function transactionFor({
  input,
  lock,
  owner,
  plan,
  target,
  workspace,
}) {
  const stagingPath = resolve(
    workspace.content.path,
    `${AUTHOR_STAGING_PREFIX}${owner}`,
  );
  return {
    articleDirectoryIdentity: target.articleDirectory.identity,
    candidateAtTarget: false,
    candidateBytes: Buffer.from(plan.fileContent, "utf8"),
    candidateFileContent: plan.fileContent,
    candidateIdentity: undefined,
    candidateIdentityBound: false,
    candidateInStaging: false,
    candidateWasActivated: false,
    candidatePath: resolve(stagingPath, "candidate"),
    input,
    lock,
    originalBytes: Buffer.from(target.snapshot.bytes),
    originalFileContent: decodeUtf8(target.snapshot.bytes, target.sourcePath),
    originalIdentity: undefined,
    originalInStaging: false,
    originalMode: Number(target.snapshot.identity.mode & 0o7777n),
    originalPath: resolve(stagingPath, "original"),
    originalTarget: target,
    restoredIdentity: undefined,
    sourcePath: target.sourcePath,
    stagingIdentity: undefined,
    stagingPath,
    stagingPresent: false,
  };
}

function resultFor(input, plan, sourcePath) {
  return Object.freeze({
    action: input.action,
    changed: plan.changed,
    publishedAt: plan.publishedAt,
    sourcePath,
    updatedAt: plan.updatedAt,
  });
}

function readHistoryHead(result, sourcePath) {
  let descriptor;
  try {
    if (!isPlainRecord(result)) {
      throw new TypeError("history result is not a plain record");
    }
    descriptor = Object.getOwnPropertyDescriptor(result, "head");
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || !descriptor.enumerable
      || typeof descriptor.value !== "string"
      || !OBJECT_ID_PATTERN.test(descriptor.value)
    ) {
      throw new TypeError("history result does not contain a stable HEAD");
    }
    return descriptor.value;
  } catch (cause) {
    fail("AUTHOR_DATE_CONTENT", {cause, sourcePath});
  }
}

function assertExpectedHead(expectedHead, workspace, dependencies, sourcePath) {
  try {
    const currentHead = dependencies.readHead(workspace.root);
    if (
      typeof currentHead !== "string"
      || !OBJECT_ID_PATTERN.test(currentHead)
      || currentHead !== expectedHead
    ) {
      throw new TypeError("HEAD changed during article date transaction");
    }
  } catch (cause) {
    if (cause instanceof SetArticleDatesError) throw cause;
    fail("AUTHOR_DATE_DRIFT", {cause, sourcePath});
  }
}

function releaseOperationLock({
  dependencies,
  expectedHead,
  lock,
  sourcePath,
  validateTarget,
  workspace,
}) {
  releaseAuthorLock(lock, {
    releaseLockBoundary(currentLock) {
      dependencies.releaseLockBoundary(currentLock);
      assertExpectedHead(
        expectedHead,
        workspace,
        dependencies,
        sourcePath,
      );
      validateTarget();
      assertNoBuildTransaction(workspace);
      assertAuthorLock(currentLock);
    },
  });
}

export async function setArticleDates({
  arguments_,
  dependencies: dependencyOverrides,
  environment = process.env,
  root = process.cwd(),
  testHooks: testHookOverrides,
} = {}) {
  const input = parseSetArticleDatesArguments(arguments_);
  const dependencies = validateDependencies(dependencyOverrides);
  const hooks = validateTestHooks(testHookOverrides);
  const workspace = inspectWorkspace(root);
  assertAuthorRuntime(workspace);
  assertManualAuthorEnvironment(environment);
  assertNoAuthorTransactionResidue({root: workspace.root});
  assertNoBuildTransaction(workspace);
  const initialTarget = inspectArticleTarget(workspace, input.sourceName);

  let owner;
  try {
    owner = dependencies.createOwner();
  } catch (cause) {
    failShared("AUTHOR_LOCK", {cause, sourcePath: AUTHOR_LOCK_FILE});
  }
  if (typeof owner !== "string" || !OWNER_PATTERN.test(owner)) {
    failShared("AUTHOR_LOCK", {sourcePath: AUTHOR_LOCK_FILE});
  }

  let lock;
  let transaction;
  try {
    lock = acquireAuthorLock(workspace, owner);
    invokeHook(
      hooks,
      "afterLockAcquired",
      "AUTHOR_DATE_DRIFT",
      {sourcePath: initialTarget.sourcePath},
    );
    assertNoForeignStaging(workspace);
    assertNoBuildTransaction(workspace);
    const lockedTarget = assertTargetUnchanged(
      workspace,
      input.sourceName,
      initialTarget,
    );
    assertAuthorLock(lock);

    const original = await decodeArticleSnapshot(lockedTarget, dependencies);
    let today;
    try {
      today = formatShanghaiDate(dependencies.nowMilliseconds());
    } catch (cause) {
      fail("AUTHOR_DATE_CLOCK", {
        cause,
        sourcePath: lockedTarget.sourcePath,
      });
    }
    let plan;
    try {
      plan = planArticleDateEdit({
        action: input.action,
        decoded: original.decoded,
        fileContent: original.fileContent,
        today,
      });
    } catch (cause) {
      if (cause instanceof ArticleDateEditError) {
        fail(cause.code, {
          cause,
          sourcePath: lockedTarget.sourcePath,
        });
      }
      fail("AUTHOR_DATE_INTERNAL", {
        cause,
        sourcePath: lockedTarget.sourcePath,
      });
    }
    await assertCandidateRoundTrip({
      dependencies,
      originalDecoded: original.decoded,
      plan,
      target: lockedTarget,
    });
    let candidateHistory;
    try {
      candidateHistory = await dependencies.checkHistoryCandidate({
        action: input.action,
        articleId: plan.articleId,
        publishedAt: plan.publishedAt,
        sourceName: input.sourceName,
      });
    } catch (error) {
      if (
        error instanceof ContentHistoryError
        && (
          error.code === "CONTENT_HISTORY_DATE_STATE"
          || error.code === "CONTENT_HISTORY_DATE_CHANGED"
        )
      ) {
        fail("AUTHOR_DATE_STATE", {
          cause: error,
          sourcePath: lockedTarget.sourcePath,
        });
      }
      if (error instanceof ContentHistoryError) throw error;
      fail("AUTHOR_DATE_CONTENT", {
        cause: error,
        sourcePath: lockedTarget.sourcePath,
      });
    }
    const expectedHead = readHistoryHead(
      candidateHistory,
      lockedTarget.sourcePath,
    );
    assertTargetUnchanged(
      workspace,
      input.sourceName,
      lockedTarget,
    );
    assertNoBuildTransaction(workspace);
    assertAuthorLock(lock);

    if (!plan.changed) {
      invokeHook(
        hooks,
        "beforeFinalHistoryCheck",
        "AUTHOR_DATE_CONTENT",
        {sourcePath: lockedTarget.sourcePath},
      );
      let historyResult;
      try {
        historyResult = await dependencies.checkHistory({arguments_: []});
      } catch (error) {
        if (error instanceof ContentHistoryError) throw error;
        fail("AUTHOR_DATE_CONTENT", {
          cause: error,
          sourcePath: lockedTarget.sourcePath,
        });
      }
      const checkedHead = readHistoryHead(
        historyResult,
        lockedTarget.sourcePath,
      );
      if (checkedHead !== expectedHead) {
        fail("AUTHOR_DATE_DRIFT", {sourcePath: lockedTarget.sourcePath});
      }
      assertTargetUnchanged(
        workspace,
        input.sourceName,
        lockedTarget,
      );
      assertNoBuildTransaction(workspace);
      assertAuthorLock(lock);
      assertExpectedHead(
        expectedHead,
        workspace,
        dependencies,
        lockedTarget.sourcePath,
      );
      invokeHook(
        hooks,
        "beforeLockRelease",
        "AUTHOR_DATE_DRIFT",
        {sourcePath: lockedTarget.sourcePath},
      );
      releaseOperationLock({
        dependencies,
        expectedHead,
        lock,
        sourcePath: lockedTarget.sourcePath,
        validateTarget() {
          assertTargetUnchanged(
            workspace,
            input.sourceName,
            lockedTarget,
          );
        },
        workspace,
      });
      return resultFor(input, plan, lockedTarget.sourcePath);
    }

    transaction = transactionFor({
      input,
      lock,
      owner,
      plan,
      target: lockedTarget,
      workspace,
    });
    createStaging(transaction, workspace, hooks, dependencies);
    activateCandidate(transaction, workspace, hooks, dependencies);
    invokeHook(
      hooks,
      "beforeStagingCleanup",
      "AUTHOR_DATE_CONTENT",
      {sourcePath: transaction.sourcePath},
    );
    cleanupOwnedStaging(transaction, workspace, dependencies);
    assertCandidateTarget(transaction, workspace);
    assertNoBuildTransaction(workspace);
    assertAuthorLock(lock);
    assertExpectedHead(
      expectedHead,
      workspace,
      dependencies,
      transaction.sourcePath,
    );
    invokeHook(
      hooks,
      "beforeFinalHistoryCheck",
      "AUTHOR_DATE_CONTENT",
      {sourcePath: transaction.sourcePath},
    );
    let historyResult;
    try {
      historyResult = await dependencies.checkHistory({arguments_: []});
    } catch (error) {
      if (error instanceof ContentHistoryError) throw error;
      fail("AUTHOR_DATE_CONTENT", {
        cause: error,
        sourcePath: transaction.sourcePath,
      });
    }
    const checkedHead = readHistoryHead(
      historyResult,
      transaction.sourcePath,
    );
    if (checkedHead !== expectedHead) {
      fail("AUTHOR_DATE_DRIFT", {sourcePath: transaction.sourcePath});
    }
    assertCandidateTarget(transaction, workspace);
    assertNoBuildTransaction(workspace);
    assertAuthorLock(lock);
    assertExpectedHead(
      expectedHead,
      workspace,
      dependencies,
      transaction.sourcePath,
    );
    invokeHook(
      hooks,
      "beforeLockRelease",
      "AUTHOR_DATE_DRIFT",
      {sourcePath: transaction.sourcePath},
    );
    releaseOperationLock({
      dependencies,
      expectedHead,
      lock,
      sourcePath: transaction.sourcePath,
      validateTarget() {
        assertCandidateTarget(transaction, workspace);
      },
      workspace,
    });
    return resultFor(input, plan, transaction.sourcePath);
  } catch (operationError) {
    const cleanupTarget = transaction ?? {
      candidateAtTarget: false,
      input,
      lock,
      originalTarget: initialTarget,
      sourcePath: initialTarget.sourcePath,
      stagingPresent: false,
    };
    const rollbackErrors = rollbackTransaction(
      cleanupTarget,
      workspace,
      hooks,
      dependencies,
    );
    if (rollbackErrors.length > 0) {
      failShared("AUTHOR_ROLLBACK", {
        cause: new AggregateError(
          [operationError, ...rollbackErrors],
          "article date transaction rollback failed",
        ),
        sourcePath: initialTarget.sourcePath,
      });
    }
    throw operationError;
  }
}

export function formatSetArticleDatesError(error) {
  if (error instanceof ContentHistoryError) {
    return formatContentHistoryError(error);
  }
  if (error instanceof AuthorTransactionStateError) {
    return formatAuthorTransactionStateError(error);
  }
  if (error instanceof ArticleCreateError) {
    return formatArticleCreateError(error);
  }
  if (error instanceof ArticleDateEditError) {
    return `[${error.code}] ${error.message} source=site-content/writing field=arguments`;
  }
  if (error instanceof ContentDecodeError) {
    return `[AUTHOR_DATE_SOURCE] ${ERROR_SUMMARIES.AUTHOR_DATE_SOURCE} source=${safeSourcePath(error.sourcePath)} field=arguments`;
  }
  if (!(error instanceof SetArticleDatesError)) {
    return `[AUTHOR_DATE_INTERNAL] ${ERROR_SUMMARIES.AUTHOR_DATE_INTERNAL} source=site-content/writing field=arguments`;
  }
  return `[${error.code}] ${error.message} source=${error.sourcePath} field=${error.field}`;
}

async function runCli() {
  try {
    await setArticleDates({arguments_: process.argv.slice(2)});
  } catch (error) {
    console.error(formatSetArticleDatesError(error));
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await runCli();
}

import * as crypto from "node:crypto";
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
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {isAbsolute, relative, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {
  ContentDecodeError,
  decodeFrontMatter,
} from "../content/frontmatter.mjs";
import {decodeJsonDocument} from "../content/json.mjs";
import {
  checkContentHistory,
  checkContentHistoryCandidate,
  ContentHistoryError,
  formatContentHistoryError,
} from "../quality/lib/content-history.mjs";
import {
  assertNoAuthorTransactionResidue,
  AUTHOR_LOCK_FILE,
  AUTHOR_STAGING_PREFIX,
  AuthorTransactionStateError,
  formatAuthorTransactionStateError,
  findAuthorTransactionResidue,
} from "./lib/transaction-state.mjs";

const OWNER_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SLUG_PATTERN = /^\/writing\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const SAFE_SOURCE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const REGISTRY_PATHS = Object.freeze({
  authors: "docs/contracts/authors.json",
  projects: "docs/contracts/projects.json",
  topics: "docs/contracts/topics.json",
});
const BUILD_LOCK_FILE = ".axial-muse-build.lock";
const SINGLE_FLAGS = Object.freeze([
  "--source-name",
  "--title",
  "--slug",
  "--summary",
  "--project",
  "--module",
]);
const REPEATED_FLAGS = Object.freeze([
  "--author",
  "--topic",
]);
const ALL_FLAGS = new Set([...SINGLE_FLAGS, ...REPEATED_FLAGS]);
const TEST_HOOK_NAMES = new Set([
  "afterLockAcquired",
  "afterTargetRename",
  "beforeArticleWrite",
  "beforeFileFlush",
  "beforeFinalHistoryCheck",
  "beforeRollback",
  "beforeStagingDirectoryFlush",
  "beforeTargetCheck",
  "beforeTargetRename",
  "beforeWritingDirectoryFlush",
]);
const ERROR_SUMMARIES = Object.freeze({
  AUTHOR_ARGUMENTS: "作者命令参数不合法。",
  AUTHOR_BUILD_ACTIVE: "production build 正持有内容读取边界。",
  AUTHOR_CONTENT: "新文章未通过终态内容校验。",
  AUTHOR_DIRECTORY_FLUSH: "作者事务目录未能持久化。",
  AUTHOR_FILE_FLUSH: "文章文件未能持久化。",
  AUTHOR_INTERNAL: "作者命令发生未分类错误。",
  AUTHOR_LOCK: "无法唯一取得作者事务锁。",
  AUTHOR_LOCK_IDENTITY: "作者事务锁身份发生漂移。",
  AUTHOR_LOCK_RELEASE: "作者事务锁未能作为 commit point 释放。",
  AUTHOR_REFERENCE: "文章引用了未登记或不相容的注册表 ID。",
  AUTHOR_REGISTRY: "作者命令无法可信读取注册表。",
  AUTHOR_REGISTRY_DRIFT: "注册表在作者事务期间发生漂移。",
  AUTHOR_RENAME: "完整文章 staging 未能原子激活。",
  AUTHOR_ROLLBACK: "作者事务失败且调用前状态未能完整恢复。",
  AUTHOR_RUNTIME_NODE: "当前 Node 与仓库 .nvmrc 精确版本不一致。",
  AUTHOR_RUNTIME_PLATFORM: "作者命令只允许在 Linux 运行。",
  AUTHOR_STAGING: "无法建立唯一作者 staging。",
  AUTHOR_TARGET_EXISTS: "目标文章目录已经存在。",
  AUTHOR_TEMPLATE: "新文章模板未通过冻结 frontmatter 解析器回读。",
  AUTHOR_UUID: "原生 UUIDv7 生成结果不合法。",
  AUTHOR_WORKTREE: "作者命令必须从可信仓库根普通目录运行。",
  AUTHOR_WRITE: "完整文章文件写入失败。",
});
const TEMPLATE_SECTIONS = Object.freeze([
  Object.freeze(["问题背景", "说明需要解决的问题、已有事实与证据边界。"]),
  Object.freeze(["约束与非目标", "列出本次工作的约束，以及明确不处理的事项。"]),
  Object.freeze(["方案选择", "记录候选方案、取舍依据与最终选择。"]),
  Object.freeze(["实现或实验", "给出可复核的实现、实验输入与执行步骤。"]),
  Object.freeze(["验证结果", "记录通过、失败、反例和未覆盖范围。"]),
  Object.freeze(["复盘", "区分可复用结论与只适用于当前上下文的判断。"]),
  Object.freeze(["参考来源", "补充官方资料、原始证据与必要的访问日期。"]),
]);
const DEFAULT_DEPENDENCIES = Object.freeze({
  checkHistory: checkContentHistory,
  checkHistoryCandidate: checkContentHistoryCandidate,
  createOwner: () => crypto.randomBytes(32).toString("hex"),
  createUuid: () => crypto.randomUUIDv7(),
  decodeTemplate: decodeFrontMatter,
  flushDirectory: syncDirectory,
  flushFile: (descriptor) => fsyncSync(descriptor),
  releaseLockBoundary: () => {},
  renameDirectory: (source, target) => renameSync(source, target),
  writeArticle: (descriptor, fileContent) => {
    writeFileSync(descriptor, fileContent, {encoding: "utf8"});
  },
});
const GRAPHEME_SEGMENTER = new Intl.Segmenter("zh-CN", {
  granularity: "grapheme",
});

function isPlainRecord(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isSafeSourcePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !value.startsWith("/")
    && SAFE_SOURCE_PATH_PATTERN.test(value)
    && value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function safeField(value) {
  return value === "arguments" || ALL_FLAGS.has(value) ? value : "arguments";
}

export class ArticleCreateError extends Error {
  constructor(code, {
    cause,
    field = "arguments",
    sourcePath = "site-content/writing",
  } = {}) {
    super(ERROR_SUMMARIES[code] ?? ERROR_SUMMARIES.AUTHOR_INTERNAL, {cause});
    this.name = "ArticleCreateError";
    this.code = Object.hasOwn(ERROR_SUMMARIES, code) ? code : "AUTHOR_INTERNAL";
    this.field = safeField(field);
    this.sourcePath = isSafeSourcePath(sourcePath)
      ? sourcePath
      : "site-content/writing";
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

function fail(code, details) {
  throw new ArticleCreateError(code, details);
}

function graphemeLength(value) {
  return [...GRAPHEME_SEGMENTER.segment(value)].length;
}

function isSingleLineText(value, minimum, maximum) {
  return typeof value === "string"
    && value === value.trim()
    && value.length > 0
    && !CONTROL_PATTERN.test(value)
    && !value.includes("\n")
    && !value.includes("\r")
    && graphemeLength(value) >= minimum
    && graphemeLength(value) <= maximum;
}

function isId(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 64
    && ID_PATTERN.test(value);
}

function parseFlagPairs(arguments_) {
  if (!Array.isArray(arguments_)) fail("AUTHOR_ARGUMENTS");
  const values = new Map(SINGLE_FLAGS.map((flag) => [flag, undefined]));
  values.set("--author", []);
  values.set("--topic", []);

  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      typeof flag !== "string"
      || !ALL_FLAGS.has(flag)
      || flag.includes("=")
      || typeof value !== "string"
    ) {
      fail("AUTHOR_ARGUMENTS", {field: typeof flag === "string" ? flag : "arguments"});
    }
    if (REPEATED_FLAGS.includes(flag)) {
      values.get(flag).push(value);
      continue;
    }
    if (values.get(flag) !== undefined) {
      fail("AUTHOR_ARGUMENTS", {field: flag});
    }
    values.set(flag, value);
  }
  return values;
}

function assertUniqueIds(values, minimum, maximum, field) {
  if (
    values.length < minimum
    || values.length > maximum
    || values.some((value) => !isId(value))
    || new Set(values).size !== values.length
  ) {
    fail("AUTHOR_ARGUMENTS", {field});
  }
}

export function parseCreateArticleArguments(arguments_) {
  const values = parseFlagPairs(arguments_);
  for (const flag of ["--source-name", "--title", "--slug", "--summary"]) {
    if (values.get(flag) === undefined) fail("AUTHOR_ARGUMENTS", {field: flag});
  }

  const sourceName = values.get("--source-name");
  const title = values.get("--title");
  const slug = values.get("--slug");
  const summary = values.get("--summary");
  const authors = values.get("--author");
  const topics = values.get("--topic");
  const project = values.get("--project");
  const module = values.get("--module");

  if (!isId(sourceName)) fail("AUTHOR_ARGUMENTS", {field: "--source-name"});
  if (!isSingleLineText(title, 1, 100)) fail("AUTHOR_ARGUMENTS", {field: "--title"});
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    fail("AUTHOR_ARGUMENTS", {field: "--slug"});
  }
  if (!isSingleLineText(summary, 20, 200)) {
    fail("AUTHOR_ARGUMENTS", {field: "--summary"});
  }
  assertUniqueIds(authors, 1, 4, "--author");
  assertUniqueIds(topics, 1, 5, "--topic");
  if (project !== undefined && !isId(project)) {
    fail("AUTHOR_ARGUMENTS", {field: "--project"});
  }
  if (module !== undefined && !isId(module)) {
    fail("AUTHOR_ARGUMENTS", {field: "--module"});
  }
  if (module !== undefined && project === undefined) {
    fail("AUTHOR_REFERENCE", {field: "--module"});
  }

  return Object.freeze({
    sourceName,
    title,
    slug,
    summary,
    authors: Object.freeze([...authors]),
    topics: Object.freeze([...topics]),
    ...(project === undefined ? {} : {project}),
    ...(module === undefined ? {} : {module}),
  });
}

function fileIdentity(metadata) {
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    linkCount: metadata.nlink,
    owner: metadata.uid,
    group: metadata.gid,
    size: metadata.size,
    modifiedAtNanoseconds: metadata.mtimeNs,
    changedAtNanoseconds: metadata.ctimeNs,
  });
}

function sameFileIdentity(left, right) {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.linkCount === right.linkCount
    && left.owner === right.owner
    && left.group === right.group
    && left.size === right.size
    && left.modifiedAtNanoseconds === right.modifiedAtNanoseconds
    && left.changedAtNanoseconds === right.changedAtNanoseconds;
}

function sameObjectIdentity(left, right) {
  return left.device === right.device
    && left.inode === right.inode
    && left.owner === right.owner;
}

function assertOwnedOrdinaryFile(metadata) {
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1n
    || (
      typeof process.getuid === "function"
      && metadata.uid !== BigInt(process.getuid())
    )
  ) {
    throw new TypeError("ordinary file identity mismatch");
  }
}

function assertOwnedDirectory(metadata) {
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || (
      typeof process.getuid === "function"
      && metadata.uid !== BigInt(process.getuid())
    )
  ) {
    throw new TypeError("directory identity mismatch");
  }
}

function readStableFile(path, sourcePath, errorCode = "AUTHOR_WORKTREE") {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptorBefore = fstatSync(descriptor, {bigint: true});
    const pathBefore = lstatSync(path, {bigint: true});
    assertOwnedOrdinaryFile(descriptorBefore);
    assertOwnedOrdinaryFile(pathBefore);
    const identity = fileIdentity(descriptorBefore);
    if (!sameFileIdentity(identity, fileIdentity(pathBefore))) {
      throw new TypeError("file path identity mismatch");
    }
    const bytes = Buffer.from(readFileSync(descriptor));
    const descriptorAfter = fstatSync(descriptor, {bigint: true});
    const pathAfter = lstatSync(path, {bigint: true});
    if (
      !sameFileIdentity(identity, fileIdentity(descriptorAfter))
      || !sameFileIdentity(identity, fileIdentity(pathAfter))
      || BigInt(bytes.byteLength) !== identity.size
    ) {
      throw new TypeError("file changed while reading");
    }
    return Object.freeze({bytes, identity, sourcePath});
  } catch (cause) {
    fail(errorCode, {cause, sourcePath});
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 主读取错误已失败关闭；CLI 不回显底层 close 细节。
      }
    }
  }
}

function inspectDirectory(path, sourcePath) {
  try {
    const canonical = realpathSync(path);
    const metadata = lstatSync(path, {bigint: true});
    assertOwnedDirectory(metadata);
    if (canonical !== path) throw new TypeError("directory is not canonical");
    return Object.freeze({
      identity: fileIdentity(metadata),
      path,
      sourcePath,
    });
  } catch (cause) {
    fail("AUTHOR_WORKTREE", {cause, sourcePath});
  }
}

function inspectWorkspace(root) {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) {
    fail("AUTHOR_WORKTREE");
  }
  let canonicalRoot;
  try {
    const lexicalRoot = resolve(root);
    canonicalRoot = realpathSync(lexicalRoot);
    const metadata = lstatSync(canonicalRoot, {bigint: true});
    assertOwnedDirectory(metadata);
    if (canonicalRoot !== lexicalRoot) throw new TypeError("worktree root is not canonical");
  } catch (cause) {
    fail("AUTHOR_WORKTREE", {cause});
  }

  const contentRoot = resolve(canonicalRoot, "site-content");
  const writingRoot = resolve(contentRoot, "writing");
  if (!isInside(canonicalRoot, contentRoot) || !isInside(contentRoot, writingRoot)) {
    fail("AUTHOR_WORKTREE");
  }
  const content = inspectDirectory(contentRoot, "site-content");
  const writing = inspectDirectory(writingRoot, "site-content/writing");
  if (content.identity.device !== writing.identity.device) {
    fail("AUTHOR_WORKTREE", {sourcePath: "site-content"});
  }
  return Object.freeze({
    root: canonicalRoot,
    content,
    writing,
  });
}

function assertAuthorRuntime(workspace) {
  if (process.platform !== "linux") fail("AUTHOR_RUNTIME_PLATFORM");
  const runtime = readStableFile(
    resolve(workspace.root, ".nvmrc"),
    ".nvmrc",
    "AUTHOR_RUNTIME_NODE",
  );
  const expected = runtime.bytes.toString("utf8");
  if (
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\n$/u.test(expected)
    || expected !== `${process.versions.node}\n`
  ) {
    fail("AUTHOR_RUNTIME_NODE", {sourcePath: ".nvmrc"});
  }
}

function decodeRegistry(snapshot) {
  try {
    return decodeJsonDocument({
      bytes: snapshot.bytes,
      sourcePath: snapshot.sourcePath,
    });
  } catch (cause) {
    fail("AUTHOR_REGISTRY", {
      cause,
      sourcePath: snapshot.sourcePath,
    });
  }
}

function captureRegistries(workspace) {
  const snapshots = {};
  const documents = {};
  for (const [name, sourcePath] of Object.entries(REGISTRY_PATHS)) {
    const snapshot = readStableFile(
      resolve(workspace.root, sourcePath),
      sourcePath,
      "AUTHOR_REGISTRY",
    );
    snapshots[name] = snapshot;
    documents[name] = decodeRegistry(snapshot);
  }
  return Object.freeze({
    documents: Object.freeze(documents),
    snapshots: Object.freeze(snapshots),
  });
}

function assertRegistryReferences(input, registries) {
  const authors = registries.documents.authors.authors;
  if (!isPlainRecord(authors)) {
    fail("AUTHOR_REGISTRY", {sourcePath: REGISTRY_PATHS.authors});
  }
  for (const author of input.authors) {
    if (!Object.hasOwn(authors, author) || !isPlainRecord(authors[author])) {
      fail("AUTHOR_REFERENCE", {
        field: "--author",
        sourcePath: REGISTRY_PATHS.authors,
      });
    }
  }

  const topics = registries.documents.topics.topics;
  if (!isPlainRecord(topics)) {
    fail("AUTHOR_REGISTRY", {sourcePath: REGISTRY_PATHS.topics});
  }
  for (const topic of input.topics) {
    if (!Object.hasOwn(topics, topic) || !isPlainRecord(topics[topic])) {
      fail("AUTHOR_REFERENCE", {
        field: "--topic",
        sourcePath: REGISTRY_PATHS.topics,
      });
    }
  }

  if (input.project === undefined) return;
  const projects = registries.documents.projects.projects;
  if (!Array.isArray(projects)) {
    fail("AUTHOR_REGISTRY", {sourcePath: REGISTRY_PATHS.projects});
  }
  const project = projects.find((candidate) => (
    isPlainRecord(candidate) && candidate.id === input.project
  ));
  if (project === undefined) {
    fail("AUTHOR_REFERENCE", {
      field: "--project",
      sourcePath: REGISTRY_PATHS.projects,
    });
  }
  if (input.module === undefined) return;
  if (
    !Array.isArray(project.writingModules)
    || !project.writingModules.some((candidate) => (
      isPlainRecord(candidate) && candidate.id === input.module
    ))
  ) {
    fail("AUTHOR_REFERENCE", {
      field: "--module",
      sourcePath: REGISTRY_PATHS.projects,
    });
  }
}

function assertRegistrySnapshotsCurrent(workspace, captured) {
  for (const [name, original] of Object.entries(captured.snapshots)) {
    const current = readStableFile(
      resolve(workspace.root, original.sourcePath),
      original.sourcePath,
      "AUTHOR_REGISTRY_DRIFT",
    );
    if (
      !sameFileIdentity(original.identity, current.identity)
      || !original.bytes.equals(current.bytes)
    ) {
      fail("AUTHOR_REGISTRY_DRIFT", {sourcePath: REGISTRY_PATHS[name]});
    }
  }
}

function articleSourcePath(input) {
  return `site-content/writing/${input.sourceName}/index.md`;
}

function assertTargetAbsent(targetPath, sourcePath) {
  try {
    lstatSync(targetPath);
    fail("AUTHOR_TARGET_EXISTS", {
      field: "--source-name",
      sourcePath,
    });
  } catch (error) {
    if (error instanceof ArticleCreateError) throw error;
    if (error?.code !== "ENOENT") {
      fail("AUTHOR_WORKTREE", {cause: error, sourcePath});
    }
  }
}

function expectedFrontMatter(input, articleId) {
  return {
    articleId,
    title: input.title,
    slug: input.slug,
    summary: input.summary,
    publicationStatus: "draft",
    authors: [...input.authors],
    classification: {
      ...(input.project === undefined ? {} : {project: input.project}),
      ...(input.module === undefined ? {} : {module: input.module}),
      topics: [...input.topics],
    },
  };
}

function renderArticleTemplate(input, articleId) {
  const lines = [
    "---",
    `articleId: ${JSON.stringify(articleId)}`,
    `title: ${JSON.stringify(input.title)}`,
    `slug: ${JSON.stringify(input.slug)}`,
    `summary: ${JSON.stringify(input.summary)}`,
    'publicationStatus: "draft"',
    "authors:",
    ...input.authors.map((author) => `  - ${JSON.stringify(author)}`),
    "classification:",
    ...(input.project === undefined
      ? []
      : [`  project: ${JSON.stringify(input.project)}`]),
    ...(input.module === undefined
      ? []
      : [`  module: ${JSON.stringify(input.module)}`]),
    "  topics:",
    ...input.topics.map((topic) => `    - ${JSON.stringify(topic)}`),
    "---",
    "",
  ];
  for (const [heading, instruction] of TEMPLATE_SECTIONS) {
    lines.push(`## ${heading}`, "", `<!-- TODO: ${instruction} -->`, "");
  }
  return lines.join("\n");
}

async function assertTemplateRoundTrip({
  articleId,
  dependencies,
  fileContent,
  input,
  sourcePath,
  targetFile,
}) {
  let decoded;
  try {
    decoded = await dependencies.decodeTemplate({
      fileContent,
      filePath: targetFile,
      sourcePath,
    });
  } catch (cause) {
    fail("AUTHOR_TEMPLATE", {cause, sourcePath});
  }
  const expected = expectedFrontMatter(input, articleId);
  if (
    !isPlainRecord(decoded)
    || JSON.stringify(decoded.frontMatter) !== JSON.stringify(expected)
    || typeof decoded.content !== "string"
    || decoded.content.trim() === ""
  ) {
    fail("AUTHOR_TEMPLATE", {sourcePath});
  }
}

function validateDependencies(value) {
  if (value === undefined) return DEFAULT_DEPENDENCIES;
  if (!isPlainRecord(value)) fail("AUTHOR_INTERNAL");
  const dependencies = {...DEFAULT_DEPENDENCIES, ...value};
  const allowed = new Set(Object.keys(DEFAULT_DEPENDENCIES));
  if (
    Object.keys(value).some((key) => !allowed.has(key))
    || Object.values(dependencies).some((dependency) => typeof dependency !== "function")
  ) {
    fail("AUTHOR_INTERNAL");
  }
  return Object.freeze(dependencies);
}

function validateTestHooks(value) {
  if (value === undefined) return Object.freeze({});
  if (
    !isPlainRecord(value)
    || Object.entries(value).some(([name, hook]) => (
      !TEST_HOOK_NAMES.has(name) || typeof hook !== "function"
    ))
  ) {
    fail("AUTHOR_INTERNAL");
  }
  return Object.freeze({...value});
}

function invokeHook(hooks, name, code, details) {
  try {
    hooks[name]?.();
  } catch (cause) {
    fail(code, {...details, cause});
  }
}

function assertNoForeignStaging(workspace) {
  const residue = findAuthorTransactionResidue({root: workspace.root})
    .filter((sourcePath) => sourcePath !== AUTHOR_LOCK_FILE);
  if (residue.length > 0) {
    throw new AuthorTransactionStateError(
      "AUTHOR_TRANSACTION_RESIDUE",
      residue[0],
    );
  }
}

function assertNoBuildTransaction(workspace) {
  const path = resolve(workspace.root, BUILD_LOCK_FILE);
  try {
    lstatSync(path);
    fail("AUTHOR_BUILD_ACTIVE", {sourcePath: BUILD_LOCK_FILE});
  } catch (error) {
    if (error instanceof ArticleCreateError) throw error;
    if (error?.code !== "ENOENT") {
      fail("AUTHOR_WORKTREE", {
        cause: error,
        sourcePath: BUILD_LOCK_FILE,
      });
    }
  }
}

function acquireAuthorLock(workspace, owner) {
  const path = resolve(workspace.root, AUTHOR_LOCK_FILE);
  let descriptor;
  let created = false;
  let openedIdentity;
  try {
    descriptor = openSync(
      path,
      constants.O_RDWR
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    const openedDescriptor = fstatSync(descriptor, {bigint: true});
    const openedPath = lstatSync(path, {bigint: true});
    assertOwnedOrdinaryFile(openedDescriptor);
    assertOwnedOrdinaryFile(openedPath);
    openedIdentity = fileIdentity(openedDescriptor);
    if (!sameObjectIdentity(openedIdentity, fileIdentity(openedPath))) {
      throw new TypeError("author lock creation identity mismatch");
    }
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${owner}\n`, {encoding: "utf8"});
    fsyncSync(descriptor);
    const metadata = fstatSync(descriptor, {bigint: true});
    const pathMetadata = lstatSync(path, {bigint: true});
    assertOwnedOrdinaryFile(metadata);
    assertOwnedOrdinaryFile(pathMetadata);
    if (
      !sameObjectIdentity(fileIdentity(metadata), fileIdentity(pathMetadata))
      || (metadata.mode & 0o777n) !== 0o600n
      || metadata.size !== BigInt(owner.length + 1)
    ) {
      throw new TypeError("author lock mode mismatch");
    }
    const lock = {
      descriptor,
      identity: fileIdentity(metadata),
      owner,
      path,
      unlinked: false,
    };
    assertAuthorLock(lock);
    syncDirectory(workspace.root);
    return lock;
  } catch (cause) {
    let rollbackFailed = false;
    if (created) {
      try {
        const descriptorMetadata = descriptor === undefined
          ? undefined
          : fstatSync(descriptor, {bigint: true});
        const pathMetadata = lstatSync(path, {bigint: true});
        if (
          openedIdentity === undefined
          || descriptorMetadata === undefined
          || !sameObjectIdentity(
            openedIdentity,
            fileIdentity(descriptorMetadata),
          )
          || !sameObjectIdentity(openedIdentity, fileIdentity(pathMetadata))
        ) {
          throw new TypeError("failed author lock ownership is uncertain");
        }
        unlinkSync(path);
        syncDirectory(workspace.root);
      } catch {
        rollbackFailed = true;
      }
    }
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 已删除的失败 lock 没有持久状态；关闭错误不改变失败结论。
      }
    }
    fail(rollbackFailed ? "AUTHOR_ROLLBACK" : "AUTHOR_LOCK", {
      cause,
      sourcePath: AUTHOR_LOCK_FILE,
    });
  }
}

function assertAuthorLock(lock) {
  try {
    if (lock.unlinked || lock.descriptor === undefined) {
      throw new TypeError("author lock is not held");
    }
    const expectedBytes = Buffer.from(`${lock.owner}\n`, "utf8");
    const descriptorBefore = fstatSync(lock.descriptor, {bigint: true});
    const pathBefore = lstatSync(lock.path, {bigint: true});
    assertOwnedOrdinaryFile(descriptorBefore);
    assertOwnedOrdinaryFile(pathBefore);
    const actualBytes = Buffer.alloc(expectedBytes.byteLength);
    const bytesRead = readSync(
      lock.descriptor,
      actualBytes,
      0,
      actualBytes.byteLength,
      0,
    );
    const descriptorAfter = fstatSync(lock.descriptor, {bigint: true});
    const pathAfter = lstatSync(lock.path, {bigint: true});
    if (
      !sameFileIdentity(lock.identity, fileIdentity(descriptorBefore))
      || !sameFileIdentity(lock.identity, fileIdentity(pathBefore))
      || !sameFileIdentity(lock.identity, fileIdentity(descriptorAfter))
      || !sameFileIdentity(lock.identity, fileIdentity(pathAfter))
      || bytesRead !== expectedBytes.byteLength
      || !actualBytes.equals(expectedBytes)
    ) {
      throw new TypeError("author lock identity mismatch");
    }
  } catch (cause) {
    fail("AUTHOR_LOCK_IDENTITY", {
      cause,
      sourcePath: AUTHOR_LOCK_FILE,
    });
  }
}

function syncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function releaseAuthorLock(lock, dependencies) {
  assertAuthorLock(lock);
  try {
    dependencies.releaseLockBoundary(lock);
    assertAuthorLock(lock);
    unlinkSync(lock.path);
    lock.unlinked = true;
  } catch (cause) {
    fail("AUTHOR_LOCK_RELEASE", {
      cause,
      sourcePath: AUTHOR_LOCK_FILE,
    });
  }
  try {
    closeSync(lock.descriptor);
  } catch {
    // lock 删除是 commit point；已 fsync 的临时 fd 关闭错误不反转结果。
  } finally {
    lock.descriptor = undefined;
  }
}

function captureObjectIdentity(path, kind) {
  const metadata = lstatSync(path, {bigint: true});
  if (kind === "directory") assertOwnedDirectory(metadata);
  else assertOwnedOrdinaryFile(metadata);
  return fileIdentity(metadata);
}

function createStaging(transaction, fileContent, hooks, dependencies) {
  const {sourcePath} = transaction;
  try {
    mkdirSync(transaction.stagingPath, {mode: 0o700});
    transaction.stagingIdentity = captureObjectIdentity(
      transaction.stagingPath,
      "directory",
    );
    chmodSync(transaction.stagingPath, 0o700);
  } catch (cause) {
    fail("AUTHOR_STAGING", {cause, sourcePath});
  }

  let descriptor;
  try {
    descriptor = openSync(
      transaction.stagingFile,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    transaction.fileIdentity = fileIdentity(
      fstatSync(descriptor, {bigint: true}),
    );
    invokeHook(hooks, "beforeArticleWrite", "AUTHOR_WRITE", {sourcePath});
    dependencies.writeArticle(descriptor, fileContent);
    fchmodSync(descriptor, 0o644);
    invokeHook(hooks, "beforeFileFlush", "AUTHOR_FILE_FLUSH", {sourcePath});
    try {
      dependencies.flushFile(descriptor);
    } catch (cause) {
      fail("AUTHOR_FILE_FLUSH", {cause, sourcePath});
    }
    transaction.fileIdentity = fileIdentity(
      fstatSync(descriptor, {bigint: true}),
    );
  } catch (error) {
    if (error instanceof ArticleCreateError) throw error;
    fail("AUTHOR_WRITE", {cause: error, sourcePath});
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (cause) {
        fail("AUTHOR_WRITE", {cause, sourcePath});
      }
    }
  }

  try {
    chmodSync(transaction.stagingPath, 0o755);
    invokeHook(
      hooks,
      "beforeStagingDirectoryFlush",
      "AUTHOR_DIRECTORY_FLUSH",
      {sourcePath},
    );
    dependencies.flushDirectory(transaction.stagingPath);
    transaction.stagingIdentity = captureObjectIdentity(
      transaction.stagingPath,
      "directory",
    );
  } catch (error) {
    if (error instanceof ArticleCreateError) throw error;
    fail("AUTHOR_DIRECTORY_FLUSH", {cause: error, sourcePath});
  }
}

function assertOwnedArticleTree(transaction, rootPath) {
  const directory = captureObjectIdentity(rootPath, "directory");
  const names = readdirSync(rootPath).sort();
  if (
    transaction.stagingIdentity === undefined
    || !sameObjectIdentity(transaction.stagingIdentity, directory)
    || names.length !== 1
    || names[0] !== "index.md"
  ) {
    throw new TypeError("article directory identity mismatch");
  }
  const file = captureObjectIdentity(resolve(rootPath, "index.md"), "file");
  if (
    transaction.fileIdentity === undefined
    || !sameObjectIdentity(transaction.fileIdentity, file)
  ) {
    throw new TypeError("article file identity mismatch");
  }
  const bytes = readFileSync(resolve(rootPath, "index.md"));
  if (!Buffer.from(transaction.fileContent, "utf8").equals(bytes)) {
    throw new TypeError("article file bytes changed");
  }
}

function activateStaging(
  transaction,
  workspace,
  capturedRegistries,
  hooks,
  dependencies,
) {
  const {sourcePath} = transaction;
  try {
    assertOwnedArticleTree(transaction, transaction.stagingPath);
    invokeHook(
      hooks,
      "beforeTargetCheck",
      "AUTHOR_TARGET_EXISTS",
      {field: "--source-name", sourcePath},
    );
    assertTargetAbsent(transaction.targetPath, sourcePath);
    assertRegistrySnapshotsCurrent(workspace, capturedRegistries);
    assertAuthorLock(transaction.lock);
    invokeHook(hooks, "beforeTargetRename", "AUTHOR_RENAME", {sourcePath});
    assertRegistrySnapshotsCurrent(workspace, capturedRegistries);
    assertAuthorLock(transaction.lock);
    assertTargetAbsent(transaction.targetPath, sourcePath);
    dependencies.renameDirectory(
      transaction.stagingPath,
      transaction.targetPath,
    );
    transaction.isPublished = true;
  } catch (error) {
    if (error instanceof ArticleCreateError) throw error;
    fail("AUTHOR_RENAME", {cause: error, sourcePath});
  }
  invokeHook(hooks, "afterTargetRename", "AUTHOR_CONTENT", {sourcePath});
  try {
    invokeHook(
      hooks,
      "beforeWritingDirectoryFlush",
      "AUTHOR_DIRECTORY_FLUSH",
      {sourcePath},
    );
    dependencies.flushDirectory(workspace.writing.path);
    dependencies.flushDirectory(workspace.content.path);
  } catch (error) {
    if (error instanceof ArticleCreateError) throw error;
    fail("AUTHOR_DIRECTORY_FLUSH", {cause: error, sourcePath});
  }
  try {
    assertOwnedArticleTree(transaction, transaction.targetPath);
  } catch (error) {
    if (error instanceof ArticleCreateError) throw error;
    fail("AUTHOR_CONTENT", {cause: error, sourcePath});
  }
}

function removeOwnedStaging(transaction) {
  const metadata = lstatSync(transaction.stagingPath, {bigint: true});
  assertOwnedDirectory(metadata);
  if (
    transaction.stagingIdentity === undefined
    || !sameObjectIdentity(transaction.stagingIdentity, fileIdentity(metadata))
  ) {
    throw new TypeError("staging directory identity mismatch");
  }
  const names = readdirSync(transaction.stagingPath).sort();
  if (names.some((name) => name !== "index.md") || names.length > 1) {
    throw new TypeError("staging directory contains unexpected members");
  }
  if (names[0] === "index.md") {
    const file = lstatSync(transaction.stagingFile, {bigint: true});
    assertOwnedOrdinaryFile(file);
    if (
      transaction.fileIdentity === undefined
      || !sameObjectIdentity(transaction.fileIdentity, fileIdentity(file))
    ) {
      throw new TypeError("staging file identity mismatch");
    }
    unlinkSync(transaction.stagingFile);
  }
  rmdirSync(transaction.stagingPath);
}

function rollbackTransaction(transaction, workspace, hooks, dependencies) {
  const errors = [];
  if (transaction.isPublished) {
    try {
      hooks.beforeRollback?.();
      assertOwnedArticleTree(transaction, transaction.targetPath);
      assertTargetAbsent(transaction.stagingPath, transaction.sourcePath);
      dependencies.renameDirectory(
        transaction.targetPath,
        transaction.stagingPath,
      );
      transaction.isPublished = false;
      dependencies.flushDirectory(workspace.writing.path);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    lstatSync(transaction.stagingPath);
    removeOwnedStaging(transaction);
    dependencies.flushDirectory(workspace.content.path);
  } catch (error) {
    if (error?.code !== "ENOENT") errors.push(error);
  }
  if (
    errors.length === 0
    && transaction.lock !== undefined
    && !transaction.lock.unlinked
  ) {
    try {
      releaseAuthorLock(transaction.lock, dependencies);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function transactionFor({
  articleId,
  fileContent,
  input,
  lock,
  owner,
  workspace,
}) {
  const sourcePath = articleSourcePath(input);
  const targetPath = resolve(workspace.writing.path, input.sourceName);
  const stagingPath = resolve(
    workspace.content.path,
    `${AUTHOR_STAGING_PREFIX}${owner}`,
  );
  return {
    articleId,
    fileContent,
    fileIdentity: undefined,
    input,
    isPublished: false,
    lock,
    sourcePath,
    stagingFile: resolve(stagingPath, "index.md"),
    stagingIdentity: undefined,
    stagingPath,
    targetPath,
  };
}

export async function createArticle({
  arguments_,
  dependencies: dependencyOverrides,
  root = process.cwd(),
  testHooks: testHookOverrides,
} = {}) {
  const input = parseCreateArticleArguments(arguments_);
  const dependencies = validateDependencies(dependencyOverrides);
  const hooks = validateTestHooks(testHookOverrides);
  const workspace = inspectWorkspace(root);
  assertAuthorRuntime(workspace);
  assertNoAuthorTransactionResidue({root: workspace.root});
  assertNoBuildTransaction(workspace);
  const targetPath = resolve(workspace.writing.path, input.sourceName);
  const sourcePath = articleSourcePath(input);
  assertTargetAbsent(targetPath, sourcePath);
  const registries = captureRegistries(workspace);
  assertRegistryReferences(input, registries);

  let owner;
  try {
    owner = dependencies.createOwner();
  } catch (cause) {
    fail("AUTHOR_LOCK", {cause, sourcePath: AUTHOR_LOCK_FILE});
  }
  if (!OWNER_PATTERN.test(owner)) {
    fail("AUTHOR_LOCK", {sourcePath: AUTHOR_LOCK_FILE});
  }

  let lock;
  let transaction;
  try {
    lock = acquireAuthorLock(workspace, owner);
    invokeHook(
      hooks,
      "afterLockAcquired",
      "AUTHOR_REGISTRY_DRIFT",
      {sourcePath: "docs/contracts"},
    );
    assertNoForeignStaging(workspace);
    assertNoBuildTransaction(workspace);
    assertTargetAbsent(targetPath, sourcePath);
    assertRegistrySnapshotsCurrent(workspace, registries);

    let articleId;
    try {
      articleId = dependencies.createUuid();
    } catch (cause) {
      fail("AUTHOR_UUID", {cause, sourcePath});
    }
    if (!UUID_V7_PATTERN.test(articleId)) {
      fail("AUTHOR_UUID", {sourcePath});
    }
    const fileContent = renderArticleTemplate(input, articleId);
    await assertTemplateRoundTrip({
      articleId,
      dependencies,
      fileContent,
      input,
      sourcePath,
      targetFile: resolve(targetPath, "index.md"),
    });
    try {
      await dependencies.checkHistoryCandidate({
        articleId,
        sourceName: input.sourceName,
      });
    } catch (error) {
      if (error instanceof ContentHistoryError) throw error;
      fail("AUTHOR_CONTENT", {cause: error, sourcePath});
    }
    assertRegistrySnapshotsCurrent(workspace, registries);
    assertTargetAbsent(targetPath, sourcePath);
    assertAuthorLock(lock);

    transaction = transactionFor({
      articleId,
      fileContent,
      input,
      lock,
      owner,
      workspace,
    });
    createStaging(transaction, fileContent, hooks, dependencies);
    activateStaging(
      transaction,
      workspace,
      registries,
      hooks,
      dependencies,
    );
    invokeHook(
      hooks,
      "beforeFinalHistoryCheck",
      "AUTHOR_CONTENT",
      {sourcePath},
    );
    try {
      await dependencies.checkHistory({arguments_: []});
    } catch (error) {
      if (error instanceof ContentHistoryError) throw error;
      fail("AUTHOR_CONTENT", {cause: error, sourcePath});
    }
    assertOwnedArticleTree(transaction, transaction.targetPath);
    assertRegistrySnapshotsCurrent(workspace, registries);
    assertAuthorLock(lock);
    releaseAuthorLock(lock, dependencies);
    return Object.freeze({articleId, sourcePath});
  } catch (operationError) {
    const cleanupTarget = transaction ?? {
      fileIdentity: undefined,
      isPublished: false,
      lock,
      sourcePath,
      stagingFile: resolve(
        workspace.content.path,
        `${AUTHOR_STAGING_PREFIX}${owner}`,
        "index.md",
      ),
      stagingIdentity: undefined,
      stagingPath: resolve(
        workspace.content.path,
        `${AUTHOR_STAGING_PREFIX}${owner}`,
      ),
    };
    const rollbackErrors = rollbackTransaction(
      cleanupTarget,
      workspace,
      hooks,
      dependencies,
    );
    if (rollbackErrors.length > 0) {
      fail("AUTHOR_ROLLBACK", {
        cause: new AggregateError(
          [operationError, ...rollbackErrors],
          "author transaction rollback failed",
        ),
        sourcePath,
      });
    }
    throw operationError;
  }
}

export function formatArticleCreateError(error) {
  if (error instanceof ContentHistoryError) return formatContentHistoryError(error);
  if (error instanceof AuthorTransactionStateError) {
    return formatAuthorTransactionStateError(error);
  }
  if (error instanceof ContentDecodeError) {
    return `[AUTHOR_TEMPLATE] ${ERROR_SUMMARIES.AUTHOR_TEMPLATE} source=${error.sourcePath} field=arguments`;
  }
  if (!(error instanceof ArticleCreateError)) {
    return `[AUTHOR_INTERNAL] ${ERROR_SUMMARIES.AUTHOR_INTERNAL} source=site-content/writing field=arguments`;
  }
  return `[${error.code}] ${error.message} source=${error.sourcePath} field=${error.field}`;
}

async function runCli() {
  try {
    await createArticle({arguments_: process.argv.slice(2)});
  } catch (error) {
    console.error(formatArticleCreateError(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}

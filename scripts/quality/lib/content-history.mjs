import {spawnSync} from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {registerHooks} from "node:module";
import {isAbsolute, join, relative, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {
  ContentDecodeError,
  decodeFrontMatter,
} from "../../content/frontmatter.mjs";
import {decodeJsonDocument} from "../../content/json.mjs";

const ARTICLE_PATH_PATTERN = /^site-content\/writing\/([a-z0-9]+(?:-[a-z0-9]+)*)\/index\.(?:md|mdx)$/u;
const MARKDOWN_PATH_PATTERN = /\.(?:md|mdx)$/iu;
const KEBAB_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}$/u;
const TREE_RECORD_PATTERN = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40})\t(.+)$/u;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_ARTICLE_BYTES = 4 * 1024 * 1024;
const UNKNOWN_SOURCE_PATH = "site-content";
const WORKTREE_ID = "WORKTREE";
const REGISTRY_PATHS = Object.freeze({
  authors: "docs/contracts/authors.json",
  projects: "docs/contracts/projects.json",
  topics: "docs/contracts/topics.json",
});
const HISTORY_PATHS = Object.freeze([
  "site-content/writing",
  REGISTRY_PATHS.projects,
  REGISTRY_PATHS.authors,
  REGISTRY_PATHS.topics,
]);
const GIT_ARGUMENT_PREFIX = Object.freeze([
  "-c",
  "core.commitGraph=false",
]);
const UTF8_DECODER = new TextDecoder("utf-8", {fatal: true});
const UTF8_ENCODER = new TextEncoder();
const PRODUCTION_SOURCE_ROOT_URL = new URL("../../../src/", import.meta.url);
const PRODUCTION_LOADER_URL = new URL(
  "../../../src/build/content/loader.ts",
  import.meta.url,
);
let productionLoaderPromise;

function isSafeDiagnosticPath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !value.startsWith("/")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
    && value.split("/").every((segment) => (
      segment !== ""
      && segment !== "."
      && segment !== ".."
    ));
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isKebabId(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 64
    && KEBAB_ID_PATTERN.test(value);
}

function daysInMonth(year, month) {
  if (month === 2) {
    const isLeap = year % 4 === 0
      && (year % 100 !== 0 || year % 400 === 0);
    return isLeap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  return year >= 1
    && month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth(year, month);
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export class ContentHistoryError extends Error {
  constructor(code, {
    commit = null,
    sourcePath = UNKNOWN_SOURCE_PATH,
  } = {}) {
    super("内容身份历史门禁失败。");
    this.name = "ContentHistoryError";
    this.code = code;
    this.commit = OBJECT_ID_PATTERN.test(commit ?? "") || commit === WORKTREE_ID
      ? commit
      : null;
    this.sourcePath = isSafeDiagnosticPath(sourcePath)
      ? sourcePath
      : UNKNOWN_SOURCE_PATH;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

function fail(code, details) {
  throw new ContentHistoryError(code, details);
}

function decodeUtf8(bytes, code, details) {
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    fail(code, details);
  }
  if (!sameBytes(bytes, UTF8_ENCODER.encode(text))) fail(code, details);
  return text;
}

function parseNullSeparated(bytes, code, details) {
  const text = decodeUtf8(bytes, code, details);
  if (text === "") return [];
  if (!text.endsWith("\0")) fail(code, details);
  return text.slice(0, -1).split("\0");
}

export function buildContentHistoryGitEnvironment(environment = process.env) {
  const closed = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!key.startsWith("GIT_") && value !== undefined) closed[key] = value;
  }
  return {
    ...closed,
    GIT_ALLOW_PROTOCOL: "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function runGit({
  arguments_,
  code,
  cwd,
  environment,
  sourcePath = UNKNOWN_SOURCE_PATH,
}) {
  const result = spawnSync("git", [...GIT_ARGUMENT_PREFIX, ...arguments_], {
    cwd,
    encoding: null,
    env: environment,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (
    result?.error
    || result?.status !== 0
    || (result?.signal !== null && result?.signal !== undefined)
    || !Buffer.isBuffer(result?.stdout)
  ) {
    fail(code, {sourcePath});
  }
  return result.stdout;
}

function runGitText(options) {
  const bytes = runGit(options);
  const text = decodeUtf8(bytes, options.code, {
    sourcePath: options.sourcePath ?? UNKNOWN_SOURCE_PATH,
  });
  if (text.includes("\0")) {
    fail(options.code, {
      sourcePath: options.sourcePath ?? UNKNOWN_SOURCE_PATH,
    });
  }
  return text;
}

function readOptionalLocalBoolean(repositoryRoot, environment, key) {
  const result = spawnSync(
    "git",
    [
      ...GIT_ARGUMENT_PREFIX,
      "config",
      "--local",
      "--no-includes",
      "--type=bool",
      "--get-all",
      key,
    ],
    {
      cwd: repositoryRoot,
      encoding: null,
      env: environment,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    },
  );
  if (
    result?.error
    || (result?.signal !== null && result?.signal !== undefined)
    || !Buffer.isBuffer(result?.stdout)
  ) {
    fail("CONTENT_HISTORY_GIT_CONFIG");
  }
  if (result.status === 1 && result.stdout.byteLength === 0) return null;
  if (result.status !== 0) fail("CONTENT_HISTORY_GIT_CONFIG");
  const values = decodeUtf8(
    result.stdout,
    "CONTENT_HISTORY_GIT_CONFIG",
    {sourcePath: UNKNOWN_SOURCE_PATH},
  ).split("\n");
  if (values.at(-1) !== "") fail("CONTENT_HISTORY_GIT_CONFIG");
  values.pop();
  if (
    values.length !== 1
    || (values[0] !== "true" && values[0] !== "false")
  ) {
    fail("CONTENT_HISTORY_GIT_CONFIG");
  }
  return values[0] === "true";
}

function singleLine(text, code, details) {
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) fail(code, details);
  return text.slice(0, -1);
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function inspectProductionSourceRoot() {
  if (
    PRODUCTION_SOURCE_ROOT_URL.protocol !== "file:"
    || PRODUCTION_SOURCE_ROOT_URL.search !== ""
    || PRODUCTION_SOURCE_ROOT_URL.hash !== ""
  ) {
    throw new TypeError("production source root URL is not admissible");
  }
  const root = resolve(fileURLToPath(PRODUCTION_SOURCE_ROOT_URL));
  const stat = lstatSync(root);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || realpathSync(root) !== root
    || (
      typeof process.getuid === "function"
      && stat.uid !== process.getuid()
    )
  ) {
    throw new TypeError("production source root is not admissible");
  }
  return root;
}

function assertPathAbsent(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new TypeError("compiled production module must not exist");
}

function inspectProductionTypeScriptUrl(urlText, sourceRoot) {
  const url = new URL(urlText);
  if (
    url.protocol !== "file:"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new TypeError("production module URL is not admissible");
  }
  const path = fileURLToPath(url);
  const stat = lstatSync(path);
  if (
    !path.endsWith(".ts")
    || !isInside(sourceRoot, path)
    || !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || realpathSync(path) !== path
    || pathToFileURL(path).href !== url.href
    || (
      typeof process.getuid === "function"
      && stat.uid !== process.getuid()
    )
  ) {
    throw new TypeError("production TypeScript module is not admissible");
  }
  return path;
}

function isProductionSourceParent(parentUrl, sourceRoot) {
  if (typeof parentUrl !== "string") return false;
  const rootUrl = `${pathToFileURL(sourceRoot).href}/`;
  return parentUrl.startsWith(rootUrl);
}

async function importProductionLoader() {
  const sourceRoot = inspectProductionSourceRoot();
  const loaderPath = inspectProductionTypeScriptUrl(
    PRODUCTION_LOADER_URL.href,
    sourceRoot,
  );
  assertPathAbsent(`${loaderPath.slice(0, -3)}.js`);

  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        !isProductionSourceParent(context.parentURL, sourceRoot)
        || typeof specifier !== "string"
        || !specifier.endsWith(".js")
        || (!specifier.startsWith("./") && !specifier.startsWith("../"))
      ) {
        return nextResolve(specifier, context);
      }

      inspectProductionTypeScriptUrl(context.parentURL, sourceRoot);
      const javascriptUrl = new URL(specifier, context.parentURL);
      if (
        javascriptUrl.protocol !== "file:"
        || javascriptUrl.search !== ""
        || javascriptUrl.hash !== ""
      ) {
        throw new TypeError("production module specifier is not admissible");
      }
      const javascriptPath = fileURLToPath(javascriptUrl);
      if (
        !javascriptPath.endsWith(".js")
        || !isInside(sourceRoot, javascriptPath)
      ) {
        throw new TypeError("production module escaped its source root");
      }
      assertPathAbsent(javascriptPath);
      const typescriptPath = `${javascriptPath.slice(0, -3)}.ts`;
      inspectProductionTypeScriptUrl(
        pathToFileURL(typescriptPath).href,
        sourceRoot,
      );
      return {
        shortCircuit: true,
        url: pathToFileURL(typescriptPath).href,
      };
    },
    load(url, context, nextLoad) {
      if (!isProductionSourceParent(url, sourceRoot) || !url.endsWith(".ts")) {
        return nextLoad(url, context);
      }
      inspectProductionTypeScriptUrl(url, sourceRoot);
      const loaded = nextLoad(url, context);
      if (
        loaded?.format !== "module-typescript"
        || (
          typeof loaded.source !== "string"
          && !(loaded.source instanceof ArrayBuffer)
          && !ArrayBuffer.isView(loaded.source)
        )
      ) {
        throw new TypeError("production TypeScript module format is not admissible");
      }
      return loaded;
    },
  });

  try {
    const module = await import(PRODUCTION_LOADER_URL.href);
    if (typeof module.loadValidatedContent !== "function") {
      throw new TypeError("production content loader export is unavailable");
    }
    return module.loadValidatedContent;
  } finally {
    hooks.deregister();
  }
}

function getProductionLoader() {
  productionLoaderPromise ??= importProductionLoader();
  return productionLoaderPromise;
}

function resolveGitDirectory(root, rawPath, code) {
  const candidate = isAbsolute(rawPath)
    ? rawPath
    : resolve(root, rawPath);
  let canonical;
  let stat;
  try {
    canonical = realpathSync(candidate);
    stat = lstatSync(canonical);
  } catch {
    fail(code);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
  return canonical;
}

function inspectRepositoryConfigNames(configNames) {
  for (const rawName of configNames) {
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(rawName)) {
      fail("CONTENT_HISTORY_GIT_CONFIG");
    }
    const name = rawName.toLowerCase();
    if (
      name === "include.path"
      || (
        name.startsWith("includeif.")
        && name.endsWith(".path")
      )
    ) {
      fail("CONTENT_HISTORY_GIT_CONFIG");
    }
    if (name === "extensions.partialclone") {
      fail("CONTENT_HISTORY_PARTIAL_CLONE");
    }
    if (
      name.startsWith("remote.")
      && (
        name.endsWith(".promisor")
        || name.endsWith(".partialclonefilter")
      )
    ) {
      fail("CONTENT_HISTORY_PROMISOR");
    }
  }
}

function readRepositoryConfigNames(canonicalCwd, environment, scope) {
  return parseNullSeparated(runGit({
    arguments_: [
      "config",
      scope,
      "--no-includes",
      "--name-only",
      "--null",
      "--list",
    ],
    code: "CONTENT_HISTORY_GIT_CONFIG",
    cwd: canonicalCwd,
    environment,
  }), "CONTENT_HISTORY_GIT_CONFIG");
}

function inspectLegacyGrafts(
  canonicalCwd,
  commonDirectory,
  environment,
) {
  const rawPath = singleLine(runGitText({
    arguments_: ["rev-parse", "--git-path", "info/grafts"],
    code: "CONTENT_HISTORY_OBJECT_STORE",
    cwd: canonicalCwd,
    environment,
  }), "CONTENT_HISTORY_OBJECT_STORE");
  const graftsPath = resolve(canonicalCwd, rawPath);
  if (!isInside(commonDirectory, graftsPath)) {
    fail("CONTENT_HISTORY_OBJECT_STORE");
  }
  try {
    lstatSync(graftsPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("CONTENT_HISTORY_OBJECT_STORE");
  }
  fail("CONTENT_HISTORY_GRAFT");
}

function inspectRepository(cwd, environment) {
  let canonicalCwd;
  try {
    canonicalCwd = realpathSync(cwd);
  } catch {
    fail("CONTENT_HISTORY_WORKTREE");
  }
  let processCwd;
  try {
    processCwd = realpathSync(process.cwd());
  } catch {
    fail("CONTENT_HISTORY_WORKTREE");
  }
  if (canonicalCwd !== processCwd) fail("CONTENT_HISTORY_WORKTREE");

  const bare = singleLine(runGitText({
    arguments_: ["rev-parse", "--is-bare-repository"],
    code: "CONTENT_HISTORY_WORKTREE",
    cwd: canonicalCwd,
    environment,
  }), "CONTENT_HISTORY_WORKTREE");
  if (bare !== "false") fail("CONTENT_HISTORY_WORKTREE");

  const topLevel = singleLine(runGitText({
    arguments_: ["rev-parse", "--show-toplevel"],
    code: "CONTENT_HISTORY_WORKTREE",
    cwd: canonicalCwd,
    environment,
  }), "CONTENT_HISTORY_WORKTREE");
  let canonicalTopLevel;
  try {
    canonicalTopLevel = realpathSync(topLevel);
  } catch {
    fail("CONTENT_HISTORY_WORKTREE");
  }
  if (canonicalTopLevel !== canonicalCwd) fail("CONTENT_HISTORY_WORKTREE");

  const commonDirectoryText = singleLine(runGitText({
    arguments_: ["rev-parse", "--git-common-dir"],
    code: "CONTENT_HISTORY_OBJECT_STORE",
    cwd: canonicalCwd,
    environment,
  }), "CONTENT_HISTORY_OBJECT_STORE");
  const commonDirectory = resolveGitDirectory(
    canonicalCwd,
    commonDirectoryText,
    "CONTENT_HISTORY_OBJECT_STORE",
  );
  inspectLegacyGrafts(canonicalCwd, commonDirectory, environment);

  const localConfigNames = readRepositoryConfigNames(
    canonicalCwd,
    environment,
    "--local",
  );
  inspectRepositoryConfigNames(localConfigNames);
  if (
    localConfigNames.some((name) => (
      name.toLowerCase() === "extensions.worktreeconfig"
    ))
    && readOptionalLocalBoolean(
      canonicalCwd,
      environment,
      "extensions.worktreeConfig",
    )
  ) {
    inspectRepositoryConfigNames(readRepositoryConfigNames(
      canonicalCwd,
      environment,
      "--worktree",
    ));
  }

  const alternatePath = join(commonDirectory, "objects", "info", "alternates");
  if (existsSync(alternatePath)) fail("CONTENT_HISTORY_ALTERNATE");
  const packDirectory = join(commonDirectory, "objects", "pack");
  if (existsSync(packDirectory)) {
    let entries;
    try {
      entries = readdirSync(packDirectory, {withFileTypes: true});
    } catch {
      fail("CONTENT_HISTORY_OBJECT_STORE");
    }
    if (entries.some((entry) => entry.name.endsWith(".promisor"))) {
      fail("CONTENT_HISTORY_PROMISOR");
    }
  }

  const shallow = singleLine(runGitText({
    arguments_: ["rev-parse", "--is-shallow-repository"],
    code: "CONTENT_HISTORY_SHALLOW",
    cwd: canonicalCwd,
    environment,
  }), "CONTENT_HISTORY_SHALLOW");
  if (shallow !== "false") fail("CONTENT_HISTORY_SHALLOW");

  const head = singleLine(runGitText({
    arguments_: ["rev-parse", "--verify", "HEAD^{commit}"],
    code: "CONTENT_HISTORY_HEAD",
    cwd: canonicalCwd,
    environment,
  }), "CONTENT_HISTORY_HEAD");
  if (!OBJECT_ID_PATTERN.test(head)) fail("CONTENT_HISTORY_HEAD");

  const reachableObjects = runGitText({
    arguments_: ["rev-list", "--objects", "--missing=print", "HEAD"],
    code: "CONTENT_HISTORY_OBJECT_MISSING",
    cwd: canonicalCwd,
    environment,
  });
  if (
    reachableObjects.split("\n").some((line) => line.startsWith("?"))
  ) {
    fail("CONTENT_HISTORY_OBJECT_MISSING");
  }

  return Object.freeze({
    commonDirectory,
    head,
    root: canonicalCwd,
  });
}

function readDag(repository, environment) {
  const text = runGitText({
    arguments_: ["rev-list", "--topo-order", "--reverse", "--parents", "HEAD"],
    code: "CONTENT_HISTORY_DAG",
    cwd: repository.root,
    environment,
  });
  const commits = [];
  const seen = new Set();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const parts = line.split(" ");
    if (
      parts.length < 1
      || parts.some((part) => !OBJECT_ID_PATTERN.test(part))
      || seen.has(parts[0])
    ) {
      fail("CONTENT_HISTORY_DAG");
    }
    const [commit, ...parents] = parts;
    if (parents.some((parent) => !seen.has(parent))) {
      fail("CONTENT_HISTORY_DAG", {commit});
    }
    seen.add(commit);
    commits.push(Object.freeze({commit, parents: Object.freeze(parents)}));
  }
  if (
    commits.length === 0
    || commits.at(-1).commit !== repository.head
  ) {
    fail("CONTENT_HISTORY_DAG");
  }
  return Object.freeze(commits);
}

function readTree(repository, environment, commit) {
  const records = parseNullSeparated(runGit({
    arguments_: [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      commit,
      "--",
      ...HISTORY_PATHS,
    ],
    code: "CONTENT_HISTORY_TREE",
    cwd: repository.root,
    environment,
  }), "CONTENT_HISTORY_TREE", {commit});
  const entries = new Map();
  for (const record of records) {
    const match = TREE_RECORD_PATTERN.exec(record);
    if (match === null) fail("CONTENT_HISTORY_TREE", {commit});
    const [, mode, type, objectId, sourcePath] = match;
    if (!isSafeDiagnosticPath(sourcePath) || entries.has(sourcePath)) {
      fail("CONTENT_HISTORY_TREE", {commit});
    }
    entries.set(sourcePath, Object.freeze({
      mode,
      objectId,
      sourcePath,
      type,
    }));
  }
  return entries;
}

function readBlob(repository, environment, commit, entry) {
  if (entry.type !== "blob" || entry.mode !== "100644") {
    fail("CONTENT_HISTORY_FILE_TYPE", {
      commit,
      sourcePath: entry.sourcePath,
    });
  }
  return runGit({
    arguments_: ["cat-file", "blob", entry.objectId],
    code: "CONTENT_HISTORY_BLOB",
    cwd: repository.root,
    environment,
    sourcePath: entry.sourcePath,
  });
}

function collectHistoricalArticleEntries(repository, environment, commit, tree) {
  const articles = [];
  for (const entry of tree.values()) {
    if (!entry.sourcePath.startsWith("site-content/writing/")) continue;
    if (!MARKDOWN_PATH_PATTERN.test(entry.sourcePath)) continue;
    if (!ARTICLE_PATH_PATTERN.test(entry.sourcePath)) {
      fail("CONTENT_HISTORY_ARTICLE_PATH", {
        commit,
        sourcePath: entry.sourcePath,
      });
    }
    articles.push(Object.freeze({
      bytes: readBlob(repository, environment, commit, entry),
      filePath: resolve(repository.root, entry.sourcePath),
      sourcePath: entry.sourcePath,
    }));
  }
  return articles;
}

function collectHistoricalRegistryEntries(repository, environment, commit, tree) {
  const registries = new Map();
  for (const sourcePath of Object.values(REGISTRY_PATHS)) {
    const entry = tree.get(sourcePath);
    if (entry !== undefined) {
      registries.set(
        sourcePath,
        readBlob(repository, environment, commit, entry),
      );
    }
  }
  return registries;
}

function addUniqueIdentity(target, identity, code, details) {
  if (target.has(identity)) fail(code, details);
  target.add(identity);
}

function addArticleIdentity(
  articleBySource,
  sourceByArticle,
  {articleId, sourceName, sourcePath},
  context,
) {
  if (!isKebabId(sourceName)) {
    fail("CONTENT_HISTORY_ARTICLE_PATH", {...context, sourcePath});
  }
  if (typeof articleId !== "string" || !UUID_V7_PATTERN.test(articleId)) {
    fail("CONTENT_HISTORY_ARTICLE_ID", {...context, sourcePath});
  }
  if (articleBySource.has(sourceName) || sourceByArticle.has(articleId)) {
    fail("CONTENT_HISTORY_ARTICLE_DUPLICATE", {...context, sourcePath});
  }
  articleBySource.set(sourceName, articleId);
  sourceByArticle.set(articleId, sourceName);
}

function addProjectIdentity(project, projects, registryIds, context) {
  const sourcePath = REGISTRY_PATHS.projects;
  if (!isPlainRecord(project) || !isKebabId(project.id)) {
    fail("CONTENT_HISTORY_REGISTRY_ID", {...context, sourcePath});
  }
  if (projects.has(project.id)) {
    fail("CONTENT_HISTORY_REGISTRY_DUPLICATE", {...context, sourcePath});
  }
  projects.add(project.id);
  addUniqueIdentity(
    registryIds,
    `project:${project.id}`,
    "CONTENT_HISTORY_REGISTRY_DUPLICATE",
    {...context, sourcePath},
  );

  const modules = project.writingModules === undefined
    ? []
    : project.writingModules;
  if (!Array.isArray(modules)) {
    fail("CONTENT_HISTORY_REGISTRY_SHAPE", {...context, sourcePath});
  }
  const moduleIds = new Set();
  for (const module of modules) {
    if (!isPlainRecord(module) || !isKebabId(module.id)) {
      fail("CONTENT_HISTORY_REGISTRY_ID", {...context, sourcePath});
    }
    if (moduleIds.has(module.id)) {
      fail("CONTENT_HISTORY_REGISTRY_DUPLICATE", {...context, sourcePath});
    }
    moduleIds.add(module.id);
    addUniqueIdentity(
      registryIds,
      `module:${project.id}/${module.id}`,
      "CONTENT_HISTORY_REGISTRY_DUPLICATE",
      {...context, sourcePath},
    );
  }
}

function addObjectIdentity(identity, prefix, sourcePath, registryIds, context) {
  if (!isKebabId(identity)) {
    fail("CONTENT_HISTORY_REGISTRY_ID", {...context, sourcePath});
  }
  addUniqueIdentity(
    registryIds,
    `${prefix}:${identity}`,
    "CONTENT_HISTORY_REGISTRY_DUPLICATE",
    {...context, sourcePath},
  );
}

function parseProjectsRegistry(value, registryIds, context) {
  if (!isPlainRecord(value) || !Array.isArray(value.projects)) {
    fail("CONTENT_HISTORY_REGISTRY_SHAPE", {
      ...context,
      sourcePath: REGISTRY_PATHS.projects,
    });
  }
  const projects = new Set();
  for (const project of value.projects) {
    addProjectIdentity(project, projects, registryIds, context);
  }
}

function parseObjectRegistry(value, field, prefix, sourcePath, registryIds, context) {
  if (!isPlainRecord(value) || !isPlainRecord(value[field])) {
    fail("CONTENT_HISTORY_REGISTRY_SHAPE", {
      ...context,
      sourcePath,
    });
  }
  for (const identity of Object.keys(value[field])) {
    addObjectIdentity(identity, prefix, sourcePath, registryIds, context);
  }
}

function parseRegistries(registries, context) {
  const registryIds = new Set();
  for (const [sourcePath, bytes] of registries) {
    let value;
    try {
      value = decodeJsonDocument({bytes, sourcePath});
    } catch {
      fail("CONTENT_HISTORY_REGISTRY_PARSE", {
        ...context,
        sourcePath,
      });
    }
    if (sourcePath === REGISTRY_PATHS.projects) {
      parseProjectsRegistry(value, registryIds, context);
    } else if (sourcePath === REGISTRY_PATHS.authors) {
      parseObjectRegistry(
        value,
        "authors",
        "author",
        sourcePath,
        registryIds,
        context,
      );
    } else if (sourcePath === REGISTRY_PATHS.topics) {
      parseObjectRegistry(
        value,
        "topics",
        "topic",
        sourcePath,
        registryIds,
        context,
      );
    }
  }
  return registryIds;
}

async function parseArticles(articleEntries, context) {
  const articleBySource = new Map();
  const sourceByArticle = new Map();
  const sourcePathByArticle = new Map();
  const publishedAtByArticle = new Map();
  for (const entry of articleEntries) {
    if (entry.bytes.byteLength === 0 || entry.bytes.byteLength > MAX_ARTICLE_BYTES) {
      fail("CONTENT_HISTORY_ARTICLE_BYTES", {
        ...context,
        sourcePath: entry.sourcePath,
      });
    }
    const match = ARTICLE_PATH_PATTERN.exec(entry.sourcePath);
    if (match === null || !isKebabId(match[1])) {
      fail("CONTENT_HISTORY_ARTICLE_PATH", {
        ...context,
        sourcePath: entry.sourcePath,
      });
    }
    const sourceName = match[1];
    const fileContent = decodeUtf8(
      entry.bytes,
      "CONTENT_HISTORY_ARTICLE_UTF8",
      {...context, sourcePath: entry.sourcePath},
    );
    let decoded;
    try {
      decoded = await decodeFrontMatter({
        fileContent,
        filePath: entry.filePath,
        sourcePath: entry.sourcePath,
      });
    } catch (error) {
      if (
        error instanceof ContentDecodeError
        && error.code === "CONTENT_FRONTMATTER_DEPENDENCY"
      ) {
        fail("CONTENT_HISTORY_DEPENDENCY", {
          ...context,
          sourcePath: entry.sourcePath,
        });
      }
      fail("CONTENT_HISTORY_FRONTMATTER", {
        ...context,
        sourcePath: entry.sourcePath,
      });
    }
    addArticleIdentity(
      articleBySource,
      sourceByArticle,
      {
        articleId: decoded.frontMatter.articleId,
        sourceName,
        sourcePath: entry.sourcePath,
      },
      context,
    );
    sourcePathByArticle.set(decoded.frontMatter.articleId, entry.sourcePath);
    if (Object.hasOwn(decoded.frontMatter, "publishedAt")) {
      if (!isDate(decoded.frontMatter.publishedAt)) {
        fail("CONTENT_HISTORY_PUBLISHED_AT", {
          ...context,
          sourcePath: entry.sourcePath,
        });
      }
      publishedAtByArticle.set(
        decoded.frontMatter.articleId,
        decoded.frontMatter.publishedAt,
      );
    }
  }
  return Object.freeze({
    articleBySource,
    publishedAtByArticle,
    sourceByArticle,
    sourcePathByArticle,
  });
}

async function createSnapshot({
  articleEntries,
  commit,
  registries,
}) {
  const articles = await parseArticles(articleEntries, {commit});
  return Object.freeze({
    articleBySource: articles.articleBySource,
    articleIds: new Set(articles.sourceByArticle.keys()),
    publishedAtByArticle: articles.publishedAtByArticle,
    registryIds: parseRegistries(registries, {commit}),
    sourcePathByArticle: articles.sourcePathByArticle,
  });
}

function projectValidatedCurrentSnapshot(content) {
  const context = {commit: WORKTREE_ID};
  if (
    !isPlainRecord(content)
    || !isPlainRecord(content.catalog)
    || !Array.isArray(content.catalog.projects)
    || !Array.isArray(content.catalog.authors)
    || !Array.isArray(content.catalog.topics)
    || !Array.isArray(content.articles)
  ) {
    fail("CONTENT_HISTORY_CURRENT_SCHEMA", context);
  }

  const articleBySource = new Map();
  const sourceByArticle = new Map();
  const sourcePathByArticle = new Map();
  const publishedAtByArticle = new Map();
  for (const article of content.articles) {
    const sourcePath = isPlainRecord(article) && isSafeDiagnosticPath(article.sourcePath)
      ? article.sourcePath
      : UNKNOWN_SOURCE_PATH;
    addArticleIdentity(
      articleBySource,
      sourceByArticle,
      {
        articleId: isPlainRecord(article) ? article.articleId : undefined,
        sourceName: isPlainRecord(article) ? article.sourceName : undefined,
        sourcePath,
      },
      context,
    );
    sourcePathByArticle.set(article.articleId, sourcePath);
    if (isPlainRecord(article) && article.publishedAt !== undefined) {
      if (!isDate(article.publishedAt)) {
        fail("CONTENT_HISTORY_PUBLISHED_AT", {
          ...context,
          sourcePath,
        });
      }
      publishedAtByArticle.set(article.articleId, article.publishedAt);
    }
  }

  const registryIds = new Set();
  const projects = new Set();
  for (const project of content.catalog.projects) {
    addProjectIdentity(project, projects, registryIds, context);
  }
  for (const author of content.catalog.authors) {
    addObjectIdentity(
      isPlainRecord(author) ? author.id : undefined,
      "author",
      REGISTRY_PATHS.authors,
      registryIds,
      context,
    );
  }
  for (const topic of content.catalog.topics) {
    addObjectIdentity(
      isPlainRecord(topic) ? topic.id : undefined,
      "topic",
      REGISTRY_PATHS.topics,
      registryIds,
      context,
    );
  }

  return Object.freeze({
    articleBySource,
    articleIds: new Set(sourceByArticle.keys()),
    publishedAtByArticle,
    registryIds,
    sourcePathByArticle,
  });
}

function rethrowCurrentContentError(error) {
  let code;
  let upstreamCode;
  let sourcePath = UNKNOWN_SOURCE_PATH;
  try {
    if (error !== null && typeof error === "object") {
      if (typeof error.code === "string") code = error.code;
      if (typeof error.upstreamCode === "string") {
        upstreamCode = error.upstreamCode;
      }
      if (isSafeDiagnosticPath(error.sourcePath)) {
        sourcePath = error.sourcePath;
      }
    }
  } catch {
    fail("CONTENT_HISTORY_CURRENT_SCHEMA", {commit: WORKTREE_ID});
  }

  const details = {commit: WORKTREE_ID, sourcePath};
  if (
    code === "CONTENT_LOAD_DECODE"
    && upstreamCode === "CONTENT_FRONTMATTER_DEPENDENCY"
  ) {
    fail("CONTENT_HISTORY_DEPENDENCY", details);
  }
  if (
    code === "CONTENT_LOAD_DECODE"
    && ARTICLE_PATH_PATTERN.test(sourcePath)
  ) {
    fail("CONTENT_HISTORY_FRONTMATTER", details);
  }
  if (
    code === "CONTENT_LOAD_DECODE"
    && Object.values(REGISTRY_PATHS).includes(sourcePath)
  ) {
    fail("CONTENT_HISTORY_REGISTRY_PARSE", details);
  }
  fail("CONTENT_HISTORY_CURRENT_SCHEMA", details);
}

function mergeReservedSources(parentStates, commit) {
  const merged = new Map();
  for (const parent of parentStates) {
    for (const [sourceName, articleId] of parent.reservedSources) {
      const existing = merged.get(sourceName);
      if (existing !== undefined && existing !== articleId) {
        fail("CONTENT_HISTORY_SOURCE_LINEAGE_CONFLICT", {commit});
      }
      merged.set(sourceName, articleId);
    }
  }
  return merged;
}

function mergeOrigins(parentStates, field, code, commit) {
  const merged = new Map();
  for (const parent of parentStates) {
    for (const [identity, origin] of parent[field]) {
      const existing = merged.get(identity);
      if (existing !== undefined && existing !== origin) {
        fail(code, {commit});
      }
      merged.set(identity, origin);
    }
  }
  return merged;
}

function mergePublishedAtLedger(parentStates, commit) {
  const merged = new Map();
  for (const parent of parentStates) {
    for (const [articleId, publishedAt] of parent.publishedAtLedger) {
      const existing = merged.get(articleId);
      if (existing !== undefined && existing !== publishedAt) {
        fail("CONTENT_HISTORY_DATE_LINEAGE_CONFLICT", {commit});
      }
      merged.set(articleId, publishedAt);
    }
  }
  return merged;
}

function articleSourcePath(snapshot, articleId) {
  return snapshot.sourcePathByArticle.get(articleId) ?? UNKNOWN_SOURCE_PATH;
}

function transitionState(commit, snapshot, parentStates) {
  const reservedSources = mergeReservedSources(parentStates, commit);
  const articleOrigins = mergeOrigins(
    parentStates,
    "articleOrigins",
    "CONTENT_HISTORY_ARTICLE_LINEAGE_CONFLICT",
    commit,
  );
  const registryOrigins = mergeOrigins(
    parentStates,
    "registryOrigins",
    "CONTENT_HISTORY_REGISTRY_LINEAGE_CONFLICT",
    commit,
  );
  const publishedAtLedger = mergePublishedAtLedger(parentStates, commit);

  for (const [sourceName, articleId] of snapshot.articleBySource) {
    const reservedArticleId = reservedSources.get(sourceName);
    if (
      reservedArticleId !== undefined
      && reservedArticleId !== articleId
    ) {
      fail("CONTENT_HISTORY_SOURCE_REUSED", {
        commit,
        sourcePath: `site-content/writing/${sourceName}`,
      });
    }
    const aliveInParent = parentStates.some((parent) => (
      parent.snapshot.articleIds.has(articleId)
    ));
    if (articleOrigins.has(articleId)) {
      if (!aliveInParent) {
        fail("CONTENT_HISTORY_ARTICLE_REINTRODUCED", {
          commit,
          sourcePath: `site-content/writing/${sourceName}`,
        });
      }
    } else {
      if (aliveInParent) fail("CONTENT_HISTORY_STATE", {commit});
      articleOrigins.set(articleId, commit);
    }
    reservedSources.set(sourceName, articleId);
  }

  for (const identity of snapshot.registryIds) {
    const aliveInParent = parentStates.some((parent) => (
      parent.snapshot.registryIds.has(identity)
    ));
    if (registryOrigins.has(identity)) {
      if (!aliveInParent) {
        fail("CONTENT_HISTORY_REGISTRY_REINTRODUCED", {commit});
      }
    } else {
      if (aliveInParent) fail("CONTENT_HISTORY_STATE", {commit});
      registryOrigins.set(identity, commit);
    }
  }

  for (const [articleId, publishedAt] of publishedAtLedger) {
    if (!snapshot.articleIds.has(articleId)) continue;
    const currentPublishedAt = snapshot.publishedAtByArticle.get(articleId);
    if (currentPublishedAt === undefined) {
      fail("CONTENT_HISTORY_DATE_REMOVED", {
        commit,
        sourcePath: articleSourcePath(snapshot, articleId),
      });
    }
    if (currentPublishedAt !== publishedAt) {
      fail("CONTENT_HISTORY_DATE_CHANGED", {
        commit,
        sourcePath: articleSourcePath(snapshot, articleId),
      });
    }
  }
  for (const [articleId, publishedAt] of snapshot.publishedAtByArticle) {
    if (!publishedAtLedger.has(articleId)) {
      publishedAtLedger.set(articleId, publishedAt);
    }
  }

  return Object.freeze({
    articleOrigins,
    publishedAtLedger,
    registryOrigins,
    reservedSources,
    snapshot,
  });
}

async function readHistoricalSnapshot(
  repository,
  environment,
  commit,
) {
  const tree = readTree(repository, environment, commit);
  return createSnapshot({
    articleEntries: collectHistoricalArticleEntries(
      repository,
      environment,
      commit,
      tree,
    ),
    commit,
    registries: collectHistoricalRegistryEntries(
      repository,
      environment,
      commit,
      tree,
    ),
  });
}

async function readCurrentSnapshot(repository) {
  let content;
  try {
    const loadValidatedContent = await getProductionLoader();
    content = await loadValidatedContent({
      mode: "production",
      repositoryRoot: repository.root,
    });
  } catch (error) {
    rethrowCurrentContentError(error);
  }
  return projectValidatedCurrentSnapshot(content);
}

function assertHeadUnchanged(repository, environment) {
  const head = singleLine(runGitText({
    arguments_: ["rev-parse", "--verify", "HEAD^{commit}"],
    code: "CONTENT_HISTORY_HEAD_DRIFT",
    cwd: repository.root,
    environment,
  }), "CONTENT_HISTORY_HEAD_DRIFT", {commit: repository.head});
  if (head !== repository.head) {
    fail("CONTENT_HISTORY_HEAD_DRIFT", {commit: repository.head});
  }
}

function readCheckOptions(options) {
  let arguments_;
  try {
    if (
      !isPlainRecord(options)
      || Object.keys(options).some((key) => key !== "arguments_")
    ) {
      fail("CONTENT_HISTORY_ARGUMENTS");
    }
    arguments_ = options.arguments_ ?? [];
  } catch (error) {
    if (error instanceof ContentHistoryError) throw error;
    fail("CONTENT_HISTORY_ARGUMENTS");
  }
  if (!Array.isArray(arguments_) || arguments_.length !== 0) {
    fail("CONTENT_HISTORY_ARGUMENTS");
  }
  return arguments_;
}

function readCandidateOptions(options) {
  let descriptors;
  try {
    if (!isPlainRecord(options)) fail("CONTENT_HISTORY_CANDIDATE");
    descriptors = Object.getOwnPropertyDescriptors(options);
  } catch (error) {
    if (error instanceof ContentHistoryError) throw error;
    fail("CONTENT_HISTORY_CANDIDATE");
  }

  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2
    || !keys.includes("articleId")
    || !keys.includes("sourceName")
    || keys.some((key) => typeof key !== "string")
  ) {
    fail("CONTENT_HISTORY_CANDIDATE");
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      !Object.hasOwn(descriptor, "value")
      || !descriptor.enumerable
    ) {
      fail("CONTENT_HISTORY_CANDIDATE");
    }
  }
  return Object.freeze({
    articleId: descriptors.articleId.value,
    sourceName: descriptors.sourceName.value,
  });
}

function readArticleDateCandidateOptions(options) {
  let descriptors;
  try {
    if (!isPlainRecord(options)) fail("CONTENT_HISTORY_DATE_CANDIDATE");
    descriptors = Object.getOwnPropertyDescriptors(options);
  } catch (error) {
    if (error instanceof ContentHistoryError) throw error;
    fail("CONTENT_HISTORY_DATE_CANDIDATE");
  }

  const expectedKeys = ["action", "articleId", "publishedAt", "sourceName"];
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expectedKeys.length
    || expectedKeys.some((key) => !keys.includes(key))
    || keys.some((key) => typeof key !== "string")
  ) {
    fail("CONTENT_HISTORY_DATE_CANDIDATE");
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      !Object.hasOwn(descriptor, "value")
      || !descriptor.enumerable
    ) {
      fail("CONTENT_HISTORY_DATE_CANDIDATE");
    }
  }

  const candidate = {
    action: descriptors.action.value,
    articleId: descriptors.articleId.value,
    publishedAt: descriptors.publishedAt.value,
    sourceName: descriptors.sourceName.value,
  };
  if (
    !["publish", "revise"].includes(candidate.action)
    || typeof candidate.articleId !== "string"
    || !UUID_V7_PATTERN.test(candidate.articleId)
    || !isDate(candidate.publishedAt)
    || !isKebabId(candidate.sourceName)
  ) {
    fail("CONTENT_HISTORY_DATE_CANDIDATE");
  }
  return Object.freeze(candidate);
}

function addCandidateToSnapshot(snapshot, candidate) {
  const articleBySource = new Map(snapshot.articleBySource);
  const sourceByArticle = new Map(
    [...snapshot.articleBySource].map(([sourceName, articleId]) => (
      [articleId, sourceName]
    )),
  );
  const sourcePath = isKebabId(candidate.sourceName)
    ? `site-content/writing/${candidate.sourceName}/index.md`
    : UNKNOWN_SOURCE_PATH;
  addArticleIdentity(
    articleBySource,
    sourceByArticle,
    {...candidate, sourcePath},
    {commit: WORKTREE_ID},
  );
  const sourcePathByArticle = new Map(snapshot.sourcePathByArticle);
  sourcePathByArticle.set(candidate.articleId, sourcePath);
  return Object.freeze({
    articleBySource,
    articleIds: new Set(sourceByArticle.keys()),
    publishedAtByArticle: new Map(snapshot.publishedAtByArticle),
    registryIds: new Set(snapshot.registryIds),
    sourcePathByArticle,
  });
}

async function readHeadHistory() {
  const environment = buildContentHistoryGitEnvironment();
  const repository = inspectRepository(process.cwd(), environment);
  const dag = readDag(repository, environment);
  const states = new Map();
  for (const node of dag) {
    const parentStates = node.parents.map((parent) => {
      const state = states.get(parent);
      if (state === undefined) fail("CONTENT_HISTORY_DAG", {commit: node.commit});
      return state;
    });
    const snapshot = await readHistoricalSnapshot(
      repository,
      environment,
      node.commit,
    );
    states.set(
      node.commit,
      transitionState(node.commit, snapshot, parentStates),
    );
  }

  const headState = states.get(repository.head);
  if (headState === undefined) fail("CONTENT_HISTORY_DAG");
  return Object.freeze({
    dag,
    environment,
    headState,
    repository,
  });
}

async function runContentHistoryCheck(candidate = null) {
  const {
    dag,
    environment,
    headState,
    repository,
  } = await readHeadHistory();
  const currentSnapshot = await readCurrentSnapshot(repository);
  const currentState = transitionState(
    WORKTREE_ID,
    currentSnapshot,
    [headState],
  );
  const checkedSnapshot = candidate === null
    ? currentSnapshot
    : addCandidateToSnapshot(currentSnapshot, candidate);
  if (candidate !== null) {
    transitionState(WORKTREE_ID, checkedSnapshot, [currentState]);
  }
  assertHeadUnchanged(repository, environment);

  return Object.freeze({
    articleCount: checkedSnapshot.articleIds.size,
    commitCount: dag.length,
    head: repository.head,
    registryIdentityCount: checkedSnapshot.registryIds.size,
  });
}

async function runArticleDateHistoryCandidate(candidate) {
  const {
    dag,
    environment,
    headState,
    repository,
  } = await readHeadHistory();
  const sourcePath = `site-content/writing/${candidate.sourceName}`;
  const reservedArticleId = headState.reservedSources.get(candidate.sourceName);
  if (
    reservedArticleId !== undefined
    && reservedArticleId !== candidate.articleId
  ) {
    fail("CONTENT_HISTORY_SOURCE_REUSED", {
      commit: WORKTREE_ID,
      sourcePath,
    });
  }
  if (
    headState.articleOrigins.has(candidate.articleId)
    && !headState.snapshot.articleIds.has(candidate.articleId)
  ) {
    fail("CONTENT_HISTORY_ARTICLE_REINTRODUCED", {
      commit: WORKTREE_ID,
      sourcePath,
    });
  }

  const historicalPublishedAt = headState.publishedAtLedger.get(
    candidate.articleId,
  );
  if (candidate.action === "publish") {
    if (historicalPublishedAt !== undefined) {
      fail("CONTENT_HISTORY_DATE_STATE", {
        commit: WORKTREE_ID,
        sourcePath,
      });
    }
  } else if (historicalPublishedAt === undefined) {
    fail("CONTENT_HISTORY_DATE_STATE", {
      commit: WORKTREE_ID,
      sourcePath,
    });
  } else if (historicalPublishedAt !== candidate.publishedAt) {
    fail("CONTENT_HISTORY_DATE_CHANGED", {
      commit: WORKTREE_ID,
      sourcePath,
    });
  }
  assertHeadUnchanged(repository, environment);

  return Object.freeze({
    articleCount: headState.snapshot.articleIds.size,
    commitCount: dag.length,
    head: repository.head,
    registryIdentityCount: headState.snapshot.registryIds.size,
  });
}

export async function checkContentHistory(options = {}) {
  readCheckOptions(options);
  return runContentHistoryCheck();
}

export async function checkContentHistoryCandidate(options) {
  return runContentHistoryCheck(readCandidateOptions(options));
}

export async function checkArticleDateHistoryCandidate(options) {
  return runArticleDateHistoryCandidate(
    readArticleDateCandidateOptions(options),
  );
}

export function formatContentHistoryError(error) {
  const code = error instanceof ContentHistoryError
    && /^[A-Z][A-Z0-9_]{1,127}$/u.test(error.code)
    ? error.code
    : "CONTENT_HISTORY_INTERNAL";
  const source = error instanceof ContentHistoryError
    ? error.sourcePath
    : UNKNOWN_SOURCE_PATH;
  const commit = error instanceof ContentHistoryError
    && error.commit !== null
    ? ` commit=${error.commit}`
    : "";
  return `[${code}] 内容身份历史门禁未通过；source=${source}${commit}`;
}

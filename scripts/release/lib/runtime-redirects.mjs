import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {dirname, isAbsolute, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  ContentDecodeError,
  decodeJsonDocument,
} from "../../content/json.mjs";

export const RUNTIME_REDIRECT_SCHEMA_VERSION = "1.0.0";
export const REDIRECT_REGISTRY_VERSION = "0.1.0";
export const CANONICAL_ORIGIN = "https://www.axialmuse.com";
export const REDIRECT_REGISTRY_SOURCE_PATH = "docs/contracts/redirects.json";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(MODULE_DIRECTORY, "../../..");
const FIXED_BUILD_ROOT = resolve(REPOSITORY_ROOT, "build");
const UNKNOWN_SOURCE_PATH = "release/unknown";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const CANONICAL_PAGE_PATH_PATTERN = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/u;
const HTML_SUFFIX_PATTERN = /\.(?:html?|xhtml)$/iu;
const VALIDATED_REGISTRIES = new WeakSet();
const REGISTRY_ROOT_KEYS = Object.freeze([
  "version",
  "kind",
  "status",
  "owner",
  "redirects",
]);
const REGISTRY_ENTRY_KEYS = Object.freeze(["from", "to", "reason"]);
const RESERVED_ROUTE_PREFIXES = Object.freeze([
  "/assets",
  "/img",
  "/.well-known",
]);
const RESERVED_ROUTE_FILES = new Set([
  "/404.html",
  "/robots.txt",
  "/sitemap.xml",
]);
const ERROR_MESSAGES = Object.freeze({
  RELEASE_REDIRECT_INPUT: "重定向派生输入不合法。",
  RELEASE_REDIRECT_BUILD_ROOT: "production build 根不合法。",
  RELEASE_REDIRECT_BUILD_ENTRY: "production build 含不受支持的文件系统成员。",
  RELEASE_REDIRECT_HTML_LAYOUT: "production HTML 不符合 trailingSlash 路由布局。",
  RELEASE_REDIRECT_ROUTE_PATH: "公开 HTML 路由不符合规范页面路径。",
  RELEASE_REDIRECT_ROUTE_DUPLICATE: "公开 HTML 路由发生重复。",
  RELEASE_REDIRECT_ROUTE_ROOT: "production payload 缺少根页面。",
  RELEASE_REDIRECT_ROUTE_RESERVED: "保留空间不得成为公开 HTML 页面路由。",
  RELEASE_REDIRECT_REGISTRY_READ: "重定向注册表无法可信读取。",
  RELEASE_REDIRECT_REGISTRY_JSON: "重定向注册表不是严格 JSON 文档。",
  RELEASE_REDIRECT_REGISTRY_SCHEMA: "重定向注册表封套不符合固定 schema。",
  RELEASE_REDIRECT_REGISTRY_ENTRY: "重定向注册表条目不符合固定 schema。",
  RELEASE_REDIRECT_PATH: "重定向路径不符合正向 allowlist。",
  RELEASE_REDIRECT_RESERVED: "重定向路径占用保留空间。",
  RELEASE_REDIRECT_SOURCE_DUPLICATE: "重定向 source 重复。",
  RELEASE_REDIRECT_SELF: "重定向不得指向自身。",
  RELEASE_REDIRECT_LOOP: "重定向图包含环。",
  RELEASE_REDIRECT_CHAIN: "重定向图包含链。",
  RELEASE_REDIRECT_SOURCE_PAGE: "重定向 source 在同一 payload 中存在静态页面。",
  RELEASE_REDIRECT_TARGET_MISSING: "重定向 target 在同一 payload 中不存在。",
  RELEASE_REDIRECT_SOURCE_COLLISION: "派生规则 source 发生冲突。",
  RELEASE_REDIRECT_TARGET_SOURCE: "派生规则 target 同时是另一条规则的 source。",
  RELEASE_REDIRECT_COMMIT: "提交身份不是精确 40 位小写 SHA。",
  RELEASE_REDIRECT_ORIGIN: "canonical origin 与固定站点身份不一致。",
});

function isSafeSourcePath(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4096
    || value.startsWith("/")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    || value.includes("\\")
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => (
    segment.length > 0
    && segment !== "."
    && segment !== ".."
  ));
}

export class RuntimeRedirectError extends Error {
  constructor(code, sourcePath = UNKNOWN_SOURCE_PATH, options = {}) {
    super(ERROR_MESSAGES[code] ?? "运行时重定向派生失败。", {
      cause: options.cause,
    });
    this.name = "RuntimeRedirectError";
    this.code = code;
    this.sourcePath = isSafeSourcePath(sourcePath)
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
  throw new RuntimeRedirectError(code, sourcePath, {cause});
}

export function formatRuntimeRedirectError(error) {
  if (!(error instanceof RuntimeRedirectError)) {
    return "[RELEASE_REDIRECT_INTERNAL] 重定向派生发生未分类错误；底层细节已抑制。";
  }
  return `[${error.code}] (${error.sourcePath}) ${error.message}`;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function assertExactOptions(options, expectedKeys) {
  let descriptors;
  let keys;
  try {
    if (!isPlainRecord(options)) throw new TypeError("options are not plain");
    descriptors = Object.getOwnPropertyDescriptors(options);
    keys = Reflect.ownKeys(descriptors);
  } catch (cause) {
    fail("RELEASE_REDIRECT_INPUT", UNKNOWN_SOURCE_PATH, cause);
  }
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => (
      typeof key !== "string"
      || !expectedKeys.includes(key)
      || !Object.hasOwn(descriptors[key], "value")
    ))
  ) {
    fail("RELEASE_REDIRECT_INPUT", UNKNOWN_SOURCE_PATH);
  }
  return Object.freeze(Object.fromEntries(
    expectedKeys.map((key) => [key, descriptors[key].value]),
  ));
}

function compareAscii(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isReservedRoute(path) {
  if (RESERVED_ROUTE_FILES.has(path)) return true;
  return RESERVED_ROUTE_PREFIXES.some((prefix) => (
    path === prefix
    || path === `${prefix}/`
    || path.startsWith(`${prefix}/`)
  ));
}

function registryEntrySourcePath(index, field) {
  return `${REDIRECT_REGISTRY_SOURCE_PATH}#redirects[${index}].${field}`;
}

function assertCanonicalPagePath(path, sourcePath, {
  allowRoot,
  rejectReserved,
  code = "RELEASE_REDIRECT_PATH",
} = {}) {
  if (typeof path === "string" && rejectReserved && isReservedRoute(path)) {
    fail(
      code === "RELEASE_REDIRECT_ROUTE_PATH"
        ? "RELEASE_REDIRECT_ROUTE_RESERVED"
        : "RELEASE_REDIRECT_RESERVED",
      sourcePath,
    );
  }
  if (
    typeof path !== "string"
    || (!allowRoot && path === "/")
    || !CANONICAL_PAGE_PATH_PATTERN.test(path)
  ) {
    fail(code, sourcePath);
  }
  return path;
}

function validateRegistryEntries(entries) {
  const sources = new Map();
  for (const [index, entry] of entries.entries()) {
    const sourcePath = `${REDIRECT_REGISTRY_SOURCE_PATH}#redirects[${index}]`;
    if (
      !hasExactKeys(entry, REGISTRY_ENTRY_KEYS)
      || typeof entry.reason !== "string"
      || entry.reason.trim().length === 0
    ) {
      fail("RELEASE_REDIRECT_REGISTRY_ENTRY", sourcePath);
    }
    assertCanonicalPagePath(
      entry.from,
      registryEntrySourcePath(index, "from"),
      {allowRoot: false, rejectReserved: true},
    );
    assertCanonicalPagePath(
      entry.to,
      registryEntrySourcePath(index, "to"),
      {allowRoot: true, rejectReserved: true},
    );
    if (sources.has(entry.from)) {
      fail(
        "RELEASE_REDIRECT_SOURCE_DUPLICATE",
        registryEntrySourcePath(index, "from"),
      );
    }
    if (entry.from === entry.to) {
      fail("RELEASE_REDIRECT_SELF", registryEntrySourcePath(index, "to"));
    }
    sources.set(entry.from, index);
  }

  const completed = new Set();
  for (const start of sources.keys()) {
    if (completed.has(start)) continue;
    const active = new Set();
    const traversed = [];
    let source = start;
    while (sources.has(source) && !completed.has(source)) {
      if (active.has(source)) {
        fail(
          "RELEASE_REDIRECT_LOOP",
          registryEntrySourcePath(sources.get(source), "to"),
        );
      }
      active.add(source);
      traversed.push(source);
      source = entries[sources.get(source)].to;
    }
    for (const visited of traversed) completed.add(visited);
  }
  for (const [index, entry] of entries.entries()) {
    if (sources.has(entry.to)) {
      fail("RELEASE_REDIRECT_CHAIN", registryEntrySourcePath(index, "to"));
    }
  }

  return Object.freeze(entries.map((entry) => Object.freeze({
    from: entry.from,
    to: entry.to,
    reason: entry.reason,
  })));
}

export function parseRedirectRegistry(bytes) {
  let decoded;
  try {
    decoded = decodeJsonDocument({
      bytes,
      sourcePath: REDIRECT_REGISTRY_SOURCE_PATH,
    });
  } catch (cause) {
    if (cause instanceof ContentDecodeError) {
      fail("RELEASE_REDIRECT_REGISTRY_JSON", REDIRECT_REGISTRY_SOURCE_PATH, cause);
    }
    fail("RELEASE_REDIRECT_REGISTRY_JSON", REDIRECT_REGISTRY_SOURCE_PATH, cause);
  }

  if (
    !hasExactKeys(decoded, REGISTRY_ROOT_KEYS)
    || decoded.version !== REDIRECT_REGISTRY_VERSION
    || decoded.kind !== "axial_muse_redirects"
    || decoded.status !== "active"
    || decoded.owner !== "AxialMuseWebsite"
    || !Array.isArray(decoded.redirects)
  ) {
    fail("RELEASE_REDIRECT_REGISTRY_SCHEMA", REDIRECT_REGISTRY_SOURCE_PATH);
  }
  const redirects = validateRegistryEntries(decoded.redirects);
  const registry = Object.freeze({
    version: REDIRECT_REGISTRY_VERSION,
    kind: "axial_muse_redirects",
    status: "active",
    owner: "AxialMuseWebsite",
    redirects,
  });
  VALIDATED_REGISTRIES.add(registry);
  return registry;
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

function assertSingleLinkRegularFile(metadata) {
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1n
  ) {
    throw new TypeError("not a single-link regular file");
  }
}

function readStableRegularFile(path, sourcePath) {
  let descriptor;
  let value;
  let operationError;
  try {
    const realPathBefore = realpathSync(path);
    if (realPathBefore !== path) {
      throw new TypeError("file path traverses a symbolic link");
    }
    const pathBefore = lstatSync(path, {bigint: true});
    assertSingleLinkRegularFile(pathBefore);
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const descriptorBefore = fstatSync(descriptor, {bigint: true});
    assertSingleLinkRegularFile(descriptorBefore);
    if (!sameFileIdentity(pathBefore, descriptorBefore)) {
      throw new TypeError("file identity changed before read");
    }
    const bytes = readFileSync(descriptor);
    const descriptorAfter = fstatSync(descriptor, {bigint: true});
    const pathAfter = lstatSync(path, {bigint: true});
    const realPathAfter = realpathSync(path);
    assertSingleLinkRegularFile(descriptorAfter);
    assertSingleLinkRegularFile(pathAfter);
    if (
      !sameFileIdentity(descriptorBefore, descriptorAfter)
      || !sameFileIdentity(descriptorAfter, pathAfter)
      || realPathAfter !== path
      || realPathAfter !== realPathBefore
      || BigInt(bytes.byteLength) !== descriptorAfter.size
    ) {
      throw new TypeError("file identity changed while reading");
    }
    value = new Uint8Array(bytes);
  } catch (cause) {
    operationError = cause;
  }

  let closeError;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (cause) {
      closeError = cause;
    }
  }
  if (
    operationError !== undefined
    || closeError !== undefined
    || value === undefined
  ) {
    const cause = operationError !== undefined && closeError !== undefined
      ? new AggregateError([operationError, closeError])
      : operationError ?? closeError;
    fail("RELEASE_REDIRECT_REGISTRY_READ", sourcePath, cause);
  }
  return value;
}

function assertCanonicalRepositoryRoot(repositoryRoot) {
  try {
    if (
      typeof repositoryRoot !== "string"
      || !isAbsolute(repositoryRoot)
      || resolve(repositoryRoot) !== repositoryRoot
      || realpathSync(repositoryRoot) !== repositoryRoot
    ) {
      throw new TypeError("repository root is not canonical");
    }
    const metadata = lstatSync(repositoryRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new TypeError("repository root is not an ordinary directory");
    }
  } catch (cause) {
    fail("RELEASE_REDIRECT_REGISTRY_READ", REDIRECT_REGISTRY_SOURCE_PATH, cause);
  }
}

export function readRedirectRegistryFromRepositoryRoot(repositoryRoot) {
  assertCanonicalRepositoryRoot(repositoryRoot);
  return parseRedirectRegistry(
    readStableRegularFile(
      resolve(repositoryRoot, REDIRECT_REGISTRY_SOURCE_PATH),
      REDIRECT_REGISTRY_SOURCE_PATH,
    ),
  );
}

export function readRedirectRegistry() {
  return readRedirectRegistryFromRepositoryRoot(REPOSITORY_ROOT);
}

function assertCanonicalBuildRoot(buildRoot) {
  try {
    if (
      typeof buildRoot !== "string"
      || !isAbsolute(buildRoot)
      || resolve(buildRoot) !== buildRoot
      || realpathSync(buildRoot) !== buildRoot
    ) {
      throw new TypeError("build root is not canonical");
    }
    const metadata = lstatSync(buildRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new TypeError("build root is not an ordinary directory");
    }
  } catch (cause) {
    fail("RELEASE_REDIRECT_BUILD_ROOT", "build", cause);
  }
}

export function publicRouteFromHtmlPath(relativePath) {
  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath.startsWith("/")
    || relativePath.includes("\\")
    || relativePath.split("/").some((segment) => (
      segment.length === 0
      || segment === "."
      || segment === ".."
    ))
  ) {
    fail("RELEASE_REDIRECT_HTML_LAYOUT", "build");
  }
  if (relativePath === "404.html") return undefined;
  let route;
  if (relativePath === "index.html") {
    route = "/";
  } else if (relativePath.endsWith("/index.html")) {
    route = `/${relativePath.slice(0, -"index.html".length)}`;
  } else {
    fail("RELEASE_REDIRECT_HTML_LAYOUT", `build/${relativePath}`);
  }
  assertCanonicalPagePath(route, `build/${relativePath}`, {
    allowRoot: true,
    rejectReserved: true,
    code: "RELEASE_REDIRECT_ROUTE_PATH",
  });
  return route;
}

export function collectPublicHtmlRoutes(buildRoot) {
  assertCanonicalBuildRoot(buildRoot);
  const routes = new Set();
  const walk = (directory, segments) => {
    let entries;
    try {
      entries = readdirSync(directory, {withFileTypes: true})
        .sort((left, right) => compareAscii(left.name, right.name));
    } catch (cause) {
      fail("RELEASE_REDIRECT_BUILD_ENTRY", "build", cause);
    }
    for (const entry of entries) {
      const relativePath = [...segments, entry.name].join("/");
      const sourcePath = `build/${relativePath}`;
      const path = resolve(directory, entry.name);
      let metadata;
      try {
        metadata = lstatSync(path, {bigint: true});
      } catch (cause) {
        fail("RELEASE_REDIRECT_BUILD_ENTRY", sourcePath, cause);
      }
      if (metadata.isSymbolicLink()) {
        fail("RELEASE_REDIRECT_BUILD_ENTRY", sourcePath);
      }
      if (metadata.isDirectory()) {
        walk(path, [...segments, entry.name]);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1n) {
        fail("RELEASE_REDIRECT_BUILD_ENTRY", sourcePath);
      }
      if (!HTML_SUFFIX_PATTERN.test(entry.name)) continue;
      if (!entry.name.endsWith(".html")) {
        fail("RELEASE_REDIRECT_HTML_LAYOUT", sourcePath);
      }
      const route = publicRouteFromHtmlPath(relativePath);
      if (route === undefined) continue;
      if (routes.has(route)) {
        fail("RELEASE_REDIRECT_ROUTE_DUPLICATE", sourcePath);
      }
      routes.add(route);
    }
  };
  walk(buildRoot, []);
  if (!routes.has("/")) fail("RELEASE_REDIRECT_ROUTE_ROOT", "build/index.html");
  return Object.freeze([...routes].sort(compareAscii));
}

function normalizePublicRoutes(publicRoutes) {
  if (!Array.isArray(publicRoutes)) {
    fail("RELEASE_REDIRECT_INPUT", "build");
  }
  const routes = new Set();
  for (const [index, route] of publicRoutes.entries()) {
    const sourcePath = `build#publicRoutes[${index}]`;
    assertCanonicalPagePath(route, sourcePath, {
      allowRoot: true,
      rejectReserved: true,
      code: "RELEASE_REDIRECT_ROUTE_PATH",
    });
    if (routes.has(route)) {
      fail("RELEASE_REDIRECT_ROUTE_DUPLICATE", sourcePath);
    }
    routes.add(route);
  }
  if (!routes.has("/")) fail("RELEASE_REDIRECT_ROUTE_ROOT", "build/index.html");
  return Object.freeze([...routes].sort(compareAscii));
}

function createRule(kind, from, to) {
  return Object.freeze({kind, from, to});
}

function renderNginxConfiguration(rules, canonicalOrigin) {
  if (rules.length === 0) return "";
  return `${rules.map((rule) => (
    `location = ${rule.from} {\n`
    + `  return 301 ${canonicalOrigin}${rule.to}$is_args$args;\n`
    + "}"
  )).join("\n")}\n`;
}

export function compileRuntimeRedirectArtifacts(options) {
  const {
    publicRoutes: inputPublicRoutes,
    registry,
    canonicalOrigin,
  } = assertExactOptions(
    options,
    ["publicRoutes", "registry", "canonicalOrigin"],
  );
  if (canonicalOrigin !== CANONICAL_ORIGIN) {
    fail("RELEASE_REDIRECT_ORIGIN", "docusaurus.config.ts");
  }
  const publicRoutes = normalizePublicRoutes(inputPublicRoutes);
  if (!isPlainRecord(registry) || !VALIDATED_REGISTRIES.has(registry)) {
    fail("RELEASE_REDIRECT_REGISTRY_SCHEMA", REDIRECT_REGISTRY_SOURCE_PATH);
  }
  const redirects = registry.redirects;
  const routeSet = new Set(publicRoutes);
  for (const [index, redirect] of redirects.entries()) {
    if (routeSet.has(redirect.from)) {
      fail(
        "RELEASE_REDIRECT_SOURCE_PAGE",
        registryEntrySourcePath(index, "from"),
      );
    }
    if (!routeSet.has(redirect.to)) {
      fail(
        "RELEASE_REDIRECT_TARGET_MISSING",
        registryEntrySourcePath(index, "to"),
      );
    }
  }

  const rulesBySource = new Map();
  const addRule = (rule, sourcePath) => {
    if (rulesBySource.has(rule.from)) {
      fail("RELEASE_REDIRECT_SOURCE_COLLISION", sourcePath);
    }
    rulesBySource.set(rule.from, rule);
  };
  for (const [index, redirect] of redirects.entries()) {
    addRule(
      createRule("registered", redirect.from.slice(0, -1), redirect.to),
      registryEntrySourcePath(index, "from"),
    );
    addRule(
      createRule("registered", redirect.from, redirect.to),
      registryEntrySourcePath(index, "from"),
    );
  }
  for (const route of publicRoutes) {
    if (route === "/") continue;
    addRule(
      createRule("canonical-slash", route.slice(0, -1), route),
      "build",
    );
  }

  for (const rule of rulesBySource.values()) {
    if (rulesBySource.has(rule.to)) {
      fail("RELEASE_REDIRECT_TARGET_SOURCE", "build");
    }
  }
  const rules = Object.freeze([...rulesBySource.values()]
    .sort((left, right) => compareAscii(left.from, right.from)));
  const manifest = Object.freeze({
    schemaVersion: RUNTIME_REDIRECT_SCHEMA_VERSION,
    canonicalOrigin: CANONICAL_ORIGIN,
    rules,
  });
  const runtimeRedirectsJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const nginxRedirectsConfig = renderNginxConfiguration(rules, CANONICAL_ORIGIN);
  const registeredRuleCount = rules
    .filter((rule) => rule.kind === "registered")
    .length;
  const canonicalSlashRuleCount = rules.length - registeredRuleCount;
  return Object.freeze({
    publicRoutes,
    rules,
    manifest,
    runtimeRedirectsJson,
    nginxRedirectsConfig,
    registeredRuleCount,
    canonicalSlashRuleCount,
  });
}

export function deriveRuntimeRedirectArtifacts(options) {
  const {
    buildRoot,
    commitSha,
    canonicalOrigin,
  } = assertExactOptions(
    options,
    ["buildRoot", "commitSha", "canonicalOrigin"],
  );
  if (
    typeof commitSha !== "string"
    || !COMMIT_PATTERN.test(commitSha)
  ) {
    fail("RELEASE_REDIRECT_COMMIT", "git/HEAD");
  }
  if (canonicalOrigin !== CANONICAL_ORIGIN) {
    fail("RELEASE_REDIRECT_ORIGIN", "docusaurus.config.ts");
  }
  assertCanonicalBuildRoot(buildRoot);
  if (buildRoot !== FIXED_BUILD_ROOT) {
    fail("RELEASE_REDIRECT_BUILD_ROOT", "build");
  }
  return compileRuntimeRedirectArtifacts({
    publicRoutes: collectPublicHtmlRoutes(buildRoot),
    registry: readRedirectRegistry(),
    canonicalOrigin,
  });
}

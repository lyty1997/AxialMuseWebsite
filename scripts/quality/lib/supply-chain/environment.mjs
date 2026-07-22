import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { OFFICIAL_REGISTRY, PROJECT_NPM_CONFIG } from "./contracts.mjs";
import { fail } from "./errors.mjs";

const SYSTEM_PATHS = Object.freeze([
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
]);

const ISOLATED_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NPM_CONFIG_USERCONFIG",
  "NPM_CONFIG_GLOBALCONFIG",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_LOGS_DIR",
  "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_REPLACE_REGISTRY_HOST",
  "NPM_CONFIG_STRICT_SSL",
  "NPM_CONFIG_IGNORE_SCRIPTS",
  "NPM_CONFIG_AUDIT",
  "NPM_CONFIG_FUND",
  "NPM_CONFIG_UPDATE_NOTIFIER",
  "NPM_CONFIG_PACKAGE_LOCK",
  "NPM_CONFIG_LOCKFILE_VERSION",
]);

function readJsonObject(path, code) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(code, "npm 发行版元数据不是合法 JSON。" );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, "npm 发行版元数据顶层必须是 object。" );
  }
  return value;
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

function assertTrustedNpmTree(npmRoot) {
  const pending = [npmRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (
        entry.isSymbolicLink()
        || (!entry.isDirectory() && !entry.isFile())
        || (stat.mode & 0o022) !== 0
        || (entry.isFile() && stat.nlink !== 1)
      ) {
        fail("NPM_CLI_TREE_TRUST", "npm 发行版加载树包含链接、特殊文件、可被其他主体写入或硬链接的条目。" );
      }
      if (entry.isDirectory()) pending.push(path);
    }
  }
}

export function deriveNpmCli(nodeExecutable) {
  let canonicalNode;
  try {
    canonicalNode = realpathSync(nodeExecutable);
  } catch {
    fail("NPM_CLI_NODE_PATH", "当前 Node 可执行文件无法规范化。" );
  }

  const prefix = resolve(dirname(canonicalNode), "..");
  const npmRoot = resolve(prefix, "lib/node_modules/npm");
  const cliPath = resolve(npmRoot, "bin/npm-cli.js");
  const packagePath = resolve(npmRoot, "package.json");

  let cliStat;
  let packageStat;
  let npmRootStat;
  try {
    npmRootStat = lstatSync(npmRoot);
    cliStat = lstatSync(cliPath);
    packageStat = lstatSync(packagePath);
  } catch {
    fail("NPM_CLI_MISSING", "当前 Node 发行版中缺少随附 npm CLI。" );
  }
  if (
    !npmRootStat.isDirectory()
    || npmRootStat.isSymbolicLink()
    || !cliStat.isFile()
    || cliStat.isSymbolicLink()
    || !packageStat.isFile()
    || packageStat.isSymbolicLink()
  ) {
    fail("NPM_CLI_FILE_TYPE", "npm CLI 与 package.json 必须是当前 Node 发行版内的普通文件。" );
  }
  if (
    (npmRootStat.mode & 0o022) !== 0
    || (cliStat.mode & 0o022) !== 0
    || (packageStat.mode & 0o022) !== 0
    || cliStat.nlink !== 1
    || packageStat.nlink !== 1
  ) {
    fail("NPM_CLI_FILE_TRUST", "npm 发行版关键路径不能被组/其他用户写入或使用硬链接别名。" );
  }
  assertTrustedNpmTree(npmRoot);

  let canonicalCli;
  let canonicalPackage;
  let canonicalNpmRoot;
  try {
    canonicalCli = realpathSync(cliPath);
    canonicalPackage = realpathSync(packagePath);
    canonicalNpmRoot = realpathSync(npmRoot);
  } catch {
    fail("NPM_CLI_REALPATH", "npm CLI 发行版路径无法规范化。" );
  }
  const canonicalPrefix = realpathSync(prefix);
  if (
    !isInside(canonicalPrefix, canonicalNpmRoot)
    || !isInside(canonicalNpmRoot, canonicalCli)
    || !isInside(canonicalNpmRoot, canonicalPackage)
  ) {
    fail("NPM_CLI_ESCAPE", "npm CLI 路径逃逸当前 Node 发行版。" );
  }

  const metadata = readJsonObject(canonicalPackage, "NPM_CLI_METADATA");
  if (metadata.name !== "npm" || metadata.bin?.npm !== "bin/npm-cli.js") {
    fail("NPM_CLI_IDENTITY", "当前 Node 发行版内的 npm 元数据身份不匹配。" );
  }
  if (typeof metadata.version !== "string") {
    fail("NPM_CLI_VERSION", "npm 发行版没有精确版本。" );
  }
  return {
    nodeExecutable: canonicalNode,
    npmCli: canonicalCli,
    npmVersion: metadata.version,
  };
}

function assertPrivateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    fail("NPM_TEMP_PERMISSIONS", "隔离临时目录必须是权限 0700 的普通目录。" );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail("NPM_TEMP_OWNER", "隔离临时目录不属于当前用户。" );
  }
}

function createPrivateDirectory(path) {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  assertPrivateDirectory(path);
}

export function createIsolationWorkspace({
  root,
  nodeExecutable,
  temporaryParent = "/tmp",
}) {
  let parent;
  try {
    parent = realpathSync(temporaryParent);
  } catch {
    fail("NPM_TEMP_PARENT", "系统临时目录不可用。" );
  }

  const tempRoot = mkdtempSync(join(parent, "axial-muse-npm-"));
  try {
    chmodSync(tempRoot, 0o700);
    assertPrivateDirectory(tempRoot);

    const paths = {
      root: tempRoot,
      home: join(tempRoot, "home"),
      cache: join(tempRoot, "cache"),
      logs: join(tempRoot, "logs"),
      tmp: join(tempRoot, "tmp"),
      config: join(tempRoot, "config"),
    };
    for (const path of Object.values(paths).slice(1)) createPrivateDirectory(path);

    paths.userconfig = join(paths.config, "user.npmrc");
    paths.globalconfig = join(paths.config, "global.npmrc");
    writeFileSync(paths.userconfig, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    writeFileSync(paths.globalconfig, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (readdirSync(paths.cache).length !== 0) {
      fail("NPM_CACHE_NOT_FRESH", "隔离 npm cache 创建后不是空目录。" );
    }

    const environment = buildIsolatedEnvironment({ paths, root, nodeExecutable });
    return { paths, environment };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 2 });
    throw error;
  }
}

function buildIsolatedEnvironment({ paths, root, nodeExecutable }) {
  let nodeDirectory;
  try {
    nodeDirectory = dirname(realpathSync(nodeExecutable));
  } catch {
    fail("NPM_ENV_NODE_PATH", "隔离环境无法规范化 Node 可执行文件。" );
  }
  const pathEntries = [...new Set([nodeDirectory, ...SYSTEM_PATHS])];
  return {
    HOME: paths.home,
    PATH: pathEntries.join(":"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: paths.tmp,
    TMP: paths.tmp,
    TEMP: paths.tmp,
    NPM_CONFIG_USERCONFIG: paths.userconfig,
    NPM_CONFIG_GLOBALCONFIG: paths.globalconfig,
    NPM_CONFIG_CACHE: paths.cache,
    NPM_CONFIG_LOGS_DIR: paths.logs,
    NPM_CONFIG_REGISTRY: PROJECT_NPM_CONFIG.registry,
    NPM_CONFIG_REPLACE_REGISTRY_HOST: PROJECT_NPM_CONFIG["replace-registry-host"],
    NPM_CONFIG_STRICT_SSL: PROJECT_NPM_CONFIG["strict-ssl"],
    NPM_CONFIG_IGNORE_SCRIPTS: PROJECT_NPM_CONFIG["ignore-scripts"],
    NPM_CONFIG_AUDIT: PROJECT_NPM_CONFIG.audit,
    NPM_CONFIG_FUND: PROJECT_NPM_CONFIG.fund,
    NPM_CONFIG_UPDATE_NOTIFIER: PROJECT_NPM_CONFIG["update-notifier"],
    NPM_CONFIG_PACKAGE_LOCK: PROJECT_NPM_CONFIG["package-lock"],
    NPM_CONFIG_LOCKFILE_VERSION: PROJECT_NPM_CONFIG["lockfile-version"],
  };
}

export function removeIsolationWorkspace(path) {
  try {
    rmSync(path, { recursive: true, force: false, maxRetries: 2 });
  } catch {
    fail("NPM_TEMP_CLEANUP", "隔离临时目录清理失败。" );
  }
}

function normalizedScalar(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return value;
}

function isInactiveSensitiveValue(value) {
  if (value === null || value === false || value === "") return true;
  if (Array.isArray(value)) return value.length === 0 || value.every((entry) => entry === "");
  return false;
}

export function parseAndValidateEffectiveConfig(stdout, paths) {
  let config;
  try {
    config = JSON.parse(stdout);
  } catch {
    fail("NPM_EFFECTIVE_CONFIG_JSON", "npm config list --json 输出不可解析。" );
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    fail("NPM_EFFECTIVE_CONFIG_SHAPE", "npm 有效配置顶层必须是 object。" );
  }

  for (const [key, expected] of Object.entries(PROJECT_NPM_CONFIG)) {
    if (normalizedScalar(config[key]) !== expected) {
      fail("NPM_EFFECTIVE_CONFIG_VALUE", `npm 有效配置 ${key} 不符合 E-010。`);
    }
  }
  for (const [key, expectedPath] of [
    ["cache", paths.cache],
    ["userconfig", paths.userconfig],
    ["globalconfig", paths.globalconfig],
    ["logs-dir", paths.logs],
  ]) {
    if (config[key] !== expectedPath) {
      fail("NPM_EFFECTIVE_CONFIG_PATH", `npm 有效配置 ${key} 未指向本次隔离目录。`);
    }
  }

  const credentialKeys = new Set([
    "_auth",
    "_auth-token",
    "_authtoken",
    "username",
    "_password",
    "password",
    "otp",
  ]);
  const connectionKeys = new Set([
    "ca",
    "cafile",
    "cert",
    "key",
    "proxy",
    "https-proxy",
    "noproxy",
  ]);
  for (const [rawKey, value] of Object.entries(config)) {
    const key = rawKey.toLowerCase();
    if (/^@[^:]+:registry$/.test(key)) {
      fail("NPM_EFFECTIVE_SCOPED_REGISTRY", "npm 有效配置包含未授权 scoped registry。" );
    }
    const credentialKey = key.startsWith("//") && /:(?:_auth|_authtoken|_auth-token|username|_password|password)$/.test(key);
    const connectionKey = key.startsWith("//") && /:(?:ca|cafile|cert|certfile|key|keyfile)$/.test(key);
    if ((credentialKeys.has(key) || credentialKey) && !isInactiveSensitiveValue(value)) {
      fail("NPM_EFFECTIVE_CREDENTIAL", "npm 有效配置包含活动认证键。" );
    }
    if ((connectionKeys.has(key) || connectionKey) && !isInactiveSensitiveValue(value)) {
      fail("NPM_EFFECTIVE_SENSITIVE", "npm 有效配置包含活动的代理或证书键。" );
    }
  }

  if (config.registry !== OFFICIAL_REGISTRY) {
    fail("NPM_EFFECTIVE_REGISTRY", "npm 有效 registry 不是官方 HTTPS 端点。" );
  }
  return config;
}

export function assertEnvironmentIsClosed(environment, context) {
  const actualKeys = Object.keys(environment).sort();
  const expectedKeys = [...ISOLATED_ENVIRONMENT_KEYS].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail("NPM_ENVIRONMENT_ALLOWLIST", "隔离子进程环境键集合偏离固定 allowlist。" );
  }
  const expectedEnvironment = buildIsolatedEnvironment(context);
  for (const [key, expected] of Object.entries(expectedEnvironment)) {
    if (environment[key] !== expected) {
      fail("NPM_ENVIRONMENT_VALUE", `隔离子进程环境 ${key} 值不符合固定契约。`);
    }
  }
  return environment;
}

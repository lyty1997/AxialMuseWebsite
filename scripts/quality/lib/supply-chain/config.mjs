import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { hasDirectPackageManagerCommand } from "./bypass.mjs";
import {
  NPM_VERSIONS_BY_ROLE,
  PROJECT_NPM_CONFIG,
  ROOT_DEPENDENCY_OVERRIDES,
  RUN_SCRIPT_ALLOWLIST,
  RUN_SCRIPT_COMMANDS,
} from "./contracts.mjs";
import { fail } from "./errors.mjs";

const DEPENDENCY_SECTIONS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

const FORBIDDEN_DEPENDENCY_FIELDS = Object.freeze([
  "bundleDependencies",
  "bundledDependencies",
  "devEngines",
  "packageManager",
  "resolutions",
  "workspaces",
]);

const COMPETING_PACKAGE_MANAGER_INPUTS = Object.freeze([
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
]);

const COMPETING_NODE_VERSION_INPUTS = new Set([
  ".node-version",
  ".tool-versions",
  ".mise.lock",
  "mise.lock",
]);

function isCompetingNodeVersionInput(name) {
  return COMPETING_NODE_VERSION_INPUTS.has(name)
    || /^\.?(?:mise|rtx)(?:\.[A-Za-z0-9_-]+)*\.toml$/.test(name);
}

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const REGISTRY_VERSION_PATTERN = /^(?:\^|~)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const EXACT_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function assertInsideRoot(root, path, code) {
  const relativePath = relative(root, path);
  if (relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/"))) {
    return;
  }
  fail(code, "关键输入路径逃逸仓库根目录。" );
}

function regularProjectFilePath(root, relativePath, code) {
  const path = resolve(root, relativePath);
  assertInsideRoot(root, path, code);

  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(code, `缺少必需文件 ${relativePath}。`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(code, `${relativePath} 必须是仓库内普通文件，不能是符号链接或特殊文件。`);
  }

  let canonicalRoot;
  let canonicalParent;
  try {
    canonicalRoot = realpathSync(root);
    canonicalParent = realpathSync(dirname(path));
  } catch {
    fail(code, `${relativePath} 的规范路径无法确认。`);
  }
  assertInsideRoot(canonicalRoot, resolve(canonicalParent, "."), code);
  return path;
}

export function readRegularProjectFile(root, relativePath, code) {
  return readFileSync(regularProjectFilePath(root, relativePath, code), "utf8");
}

export function readRegularProjectFileBytes(root, relativePath, code) {
  return readFileSync(regularProjectFilePath(root, relativePath, code));
}

export function parseProjectNpmrc(text) {
  if (text.includes("\r")) {
    fail("NPM_CONFIG_LINE_ENDING", ".npmrc 必须使用 LF 换行。" );
  }
  if (!text.endsWith("\n")) {
    fail("NPM_CONFIG_FINAL_NEWLINE", ".npmrc 必须以单个换行结束。" );
  }

  const lines = text.slice(0, -1).split("\n");
  const parsed = new Map();
  for (const [index, line] of lines.entries()) {
    if (line.length === 0 || line.trim() !== line || line.startsWith("#") || line.startsWith(";")) {
      fail("NPM_CONFIG_SYNTAX", `.npmrc 第 ${index + 1} 行不是允许的 key=value 记录。`);
    }
    const separator = line.indexOf("=");
    if (separator <= 0 || separator !== line.lastIndexOf("=")) {
      fail("NPM_CONFIG_SYNTAX", `.npmrc 第 ${index + 1} 行必须且只能包含一个等号。`);
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key.includes(":" ) || key.startsWith("@") || /\$\{|\$\(/.test(value)) {
      fail("NPM_CONFIG_FORBIDDEN", `.npmrc 第 ${index + 1} 行包含 scope、插值或敏感配置形态。`);
    }
    if (parsed.has(key)) {
      fail("NPM_CONFIG_DUPLICATE", `.npmrc 第 ${index + 1} 行重复声明配置键。`);
    }
    if (!Object.hasOwn(PROJECT_NPM_CONFIG, key)) {
      fail("NPM_CONFIG_UNKNOWN", `.npmrc 第 ${index + 1} 行包含未授权配置键。`);
    }
    if (PROJECT_NPM_CONFIG[key] !== value) {
      fail("NPM_CONFIG_VALUE", `.npmrc 的 ${key} 值不符合 E-010 固定配置。`);
    }
    parsed.set(key, value);
  }

  for (const key of Object.keys(PROJECT_NPM_CONFIG)) {
    if (!parsed.has(key)) {
      fail("NPM_CONFIG_MISSING", `.npmrc 缺少必需键 ${key}。`);
    }
  }
  if (parsed.size !== Object.keys(PROJECT_NPM_CONFIG).length) {
    fail("NPM_CONFIG_CARDINALITY", ".npmrc 必须精确包含 E-010 的九个键。" );
  }
  return Object.fromEntries(parsed);
}

export function validateProjectNpmrc(root) {
  return parseProjectNpmrc(readRegularProjectFile(root, ".npmrc", "NPM_CONFIG_FILE"));
}

function parseJsonObject(text, relativePath, code) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(code, `${relativePath} 不是合法 JSON。`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${relativePath} 顶层必须是 JSON object。`);
  }
  return value;
}

export function validateManifestObject(manifest) {
  if (
    manifest.engines !== undefined
    && (manifest.engines === null || typeof manifest.engines !== "object" || Array.isArray(manifest.engines))
  ) {
    fail("NPM_MANIFEST_ENGINES", "package.json#engines 必须是 object。" );
  }
  if (Object.hasOwn(manifest.engines ?? {}, "npm")) {
    fail("NPM_MANIFEST_SOURCE_FIELD", "package.json#engines.npm 会建立第二个 npm 版本真相源。" );
  }
  if (Object.hasOwn(manifest, "volta")) {
    fail("NPM_RUNTIME_COMPETING", "package.json#volta 会建立第二个 Node 版本真相源。" );
  }
  for (const field of FORBIDDEN_DEPENDENCY_FIELDS) {
    if (Object.hasOwn(manifest, field)) {
      fail("NPM_MANIFEST_SOURCE_FIELD", `package.json#${field} 尚未获准进入 registry-only 清单。`);
    }
  }
  const requiresD082Overrides = manifest.name === "axial-muse-website"
    || Object.hasOwn(manifest, "overrides");
  if (
    requiresD082Overrides
    && (
      manifest.overrides === null
      || typeof manifest.overrides !== "object"
      || Array.isArray(manifest.overrides)
      || JSON.stringify(Object.fromEntries(Object.entries(manifest.overrides).sort()))
        !== JSON.stringify(Object.fromEntries(Object.entries(ROOT_DEPENDENCY_OVERRIDES).sort()))
    )
  ) {
    fail(
      "NPM_MANIFEST_OVERRIDES",
      "package.json#overrides 必须精确等于 D-082 的两个传递安全覆盖。",
    );
  }

  const seen = new Map();
  for (const section of DEPENDENCY_SECTIONS) {
    if (!Object.hasOwn(manifest, section)) continue;
    const dependencies = manifest[section];
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      fail("NPM_MANIFEST_SECTION", `package.json#${section} 必须是 object。`);
    }
    for (const [name, spec] of Object.entries(dependencies)) {
      if (!PACKAGE_NAME_PATTERN.test(name)) {
        fail("NPM_MANIFEST_PACKAGE_NAME", `package.json#${section} 包含非法包名。`);
      }
      if (typeof spec !== "string" || !REGISTRY_VERSION_PATTERN.test(spec)) {
        fail("NPM_MANIFEST_SOURCE", `package.json#${section}.${name} 必须使用受控 registry semver 表达。`);
      }
      if (seen.has(name)) {
        fail("NPM_MANIFEST_DUPLICATE", `${name} 同时出现在 ${seen.get(name)} 与 ${section}。`);
      }
      seen.set(name, section);
    }
  }

  if (manifest.scripts !== undefined) {
    if (manifest.scripts === null || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts)) {
      fail("NPM_MANIFEST_SCRIPTS", "package.json#scripts 必须是 object。" );
    }
    for (const [name, command] of Object.entries(manifest.scripts)) {
      if (typeof command !== "string" || command.trim().length === 0) {
        fail("NPM_MANIFEST_SCRIPTS", `package.json#scripts.${name} 必须是非空字符串。`);
      }
      if (
        RUN_SCRIPT_ALLOWLIST.includes(name)
        && hasDirectPackageManagerCommand(command)
      ) {
        fail("NPM_MANIFEST_SCRIPT_BYPASS", `package.json#scripts.${name} 直接调用包管理器，绕过 E-010。`);
      }
      if (
        RUN_SCRIPT_ALLOWLIST.includes(name)
        && !RUN_SCRIPT_COMMANDS[name].includes(command)
      ) {
        fail("NPM_MANIFEST_SCRIPT_COMMAND", `package.json#scripts.${name} 不属于精确受控命令。`);
      }
    }
  }
  return manifest;
}

export function assertNoCompetingPackageManagerInputs(root) {
  for (const relativePath of COMPETING_PACKAGE_MANAGER_INPUTS) {
    if (existsSync(resolve(root, relativePath))) {
      fail("NPM_LOCK_COMPETING", `检测到未授权的包管理器输入 ${relativePath}。`);
    }
  }
}

export function readAndValidateManifest(root) {
  const manifest = parseJsonObject(
    readRegularProjectFile(root, "package.json", "NPM_MANIFEST_FILE"),
    "package.json",
    "NPM_MANIFEST_JSON",
  );
  return validateManifestObject(manifest);
}

function parseNodeRange(range) {
  const match = /^>=((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)) <((?:0|[1-9]\d*))$/.exec(range ?? "");
  if (!match) {
    fail("NPM_RUNTIME_ENGINES", "package.json#engines.node 必须是 >=x.y.z <major 的封闭范围。" );
  }
  return { minimum: match[1], upperMajor: Number(match[2]) };
}

function compareExactVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function readAndValidateRuntimeContract({
  root,
  manifest,
  npmVersionsByRole = NPM_VERSIONS_BY_ROLE,
}) {
  for (const name of readdirSync(root)) {
    if (isCompetingNodeVersionInput(name)) {
      fail("NPM_RUNTIME_COMPETING", `检测到第二个 Node 版本源 ${name}。`);
    }
  }
  const nvmrcText = readRegularProjectFile(root, ".nvmrc", "NPM_RUNTIME_NVMRC");
  const nvmrcMatch = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\n$/.exec(nvmrcText);
  if (!nvmrcMatch) {
    fail("NPM_RUNTIME_NVMRC", ".nvmrc 必须只包含精确三段式 Node 版本。" );
  }
  const nvmrc = nvmrcMatch[1];
  const range = parseNodeRange(manifest.engines?.node);

  if (
    npmVersionsByRole === null
    || typeof npmVersionsByRole !== "object"
    || Array.isArray(npmVersionsByRole)
    || Object.keys(npmVersionsByRole).sort().join(",") !== "minimum,primary"
  ) {
    fail("NPM_RUNTIME_ENDPOINT_SET", "npm 端点集合必须精确包含 primary 与 minimum 两个角色。" );
  }
  for (const role of ["primary", "minimum"]) {
    if (!EXACT_VERSION_PATTERN.test(npmVersionsByRole[role] ?? "")) {
      fail("NPM_RUNTIME_ENDPOINT_SCHEMA", "npm 端点角色必须绑定精确三段式版本。" );
    }
  }
  if (
    range.upperMajor !== Number(nvmrc.split(".")[0]) + 1
    || Number(range.minimum.split(".")[0]) !== Number(nvmrc.split(".")[0])
    || compareExactVersions(nvmrc, range.minimum) < 0
  ) {
    fail("NPM_RUNTIME_CONTRACT", ".nvmrc、engines 与主/最低端点没有形成精确闭包。" );
  }

  return {
    nodeVersionsByRole: {
      primary: nvmrc,
      minimum: range.minimum,
    },
    npmVersionsByRole: {
      primary: npmVersionsByRole.primary,
      minimum: npmVersionsByRole.minimum,
    },
    upperMajor: range.upperMajor,
  };
}

export function validateRuntimeContract({
  root,
  nodeVersion,
  npmVersion,
  manifest,
  npmVersionsByRole = NPM_VERSIONS_BY_ROLE,
}) {
  if (!EXACT_VERSION_PATTERN.test(nodeVersion) || !EXACT_VERSION_PATTERN.test(npmVersion)) {
    fail("NPM_RUNTIME_VERSION", "Node/npm 版本必须是精确三段式版本。" );
  }

  const contract = readAndValidateRuntimeContract({ root, manifest, npmVersionsByRole });

  let role;
  if (nodeVersion === contract.nodeVersionsByRole.primary) {
    role = "primary";
  } else if (nodeVersion === contract.nodeVersionsByRole.minimum) {
    role = "minimum";
  } else {
    fail("NPM_RUNTIME_NODE", "当前 Node 既不是 .nvmrc 主端点，也不是 engines 下界端点。" );
  }
  if (contract.npmVersionsByRole[role] !== npmVersion) {
    fail("NPM_RUNTIME_ENDPOINT", "当前角色的 Node 随附 npm 不属于 D-073 精确端点。" );
  }

  const nodeMajor = Number(nodeVersion.split(".")[0]);
  if (
    Number(contract.nodeVersionsByRole.primary.split(".")[0]) >= contract.upperMajor
    || nodeMajor >= contract.upperMajor
  ) {
    fail("NPM_RUNTIME_RANGE", ".nvmrc 或当前 Node 超出 package.json#engines.node 上界。" );
  }
  return { nodeVersion, npmVersion, role };
}

export function manifestDependencySnapshot(manifest) {
  const snapshot = {};
  for (const section of DEPENDENCY_SECTIONS) {
    if (manifest[section] !== undefined) snapshot[section] = manifest[section];
  }
  return snapshot;
}

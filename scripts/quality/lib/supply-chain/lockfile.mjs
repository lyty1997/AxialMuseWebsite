import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { OFFICIAL_REGISTRY } from "./contracts.mjs";
import { manifestDependencySnapshot, readRegularProjectFile } from "./config.mjs";
import { fail } from "./errors.mjs";

const EXACT_PACKAGE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA512_INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const PACKAGE_COMPONENT = /^[a-z0-9][a-z0-9._-]*$/;
const SCOPE_COMPONENT = /^@[a-z0-9][a-z0-9._-]*$/;

function parseLockfile(text) {
  let lockfile;
  try {
    lockfile = JSON.parse(text);
  } catch {
    fail("NPM_LOCK_JSON", "package-lock.json 不是合法 JSON。" );
  }
  if (lockfile === null || typeof lockfile !== "object" || Array.isArray(lockfile)) {
    fail("NPM_LOCK_SHAPE", "package-lock.json 顶层必须是 object。" );
  }
  return lockfile;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function validateRegistrySpec(spec, fieldPath) {
  if (
    typeof spec !== "string"
    || spec.trim() !== spec
    || spec === ""
    || /^[a-z][a-z0-9+.-]*:/i.test(spec)
    || spec.startsWith(".")
    || spec.startsWith("/")
    || spec.startsWith("\\")
    || spec.includes("/")
    || spec.includes("://")
    || spec.startsWith("git@")
    || /(?:^|[\\/])[^\\/]+\.(?:tgz|tar|tar\.gz|zip)$/i.test(spec)
    || /[\u0000-\u001f\u007f]/.test(spec)
  ) {
    fail("NPM_LOCK_DEPENDENCY_SOURCE", `${fieldPath} 不是 registry 依赖表达。`);
  }
}

function validateEntryDependencySources(entry, packagePath) {
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (entry[section] === undefined) continue;
    if (entry[section] === null || typeof entry[section] !== "object" || Array.isArray(entry[section])) {
      fail("NPM_LOCK_DEPENDENCY_SECTION", `package-lock.json#packages.${packagePath}.${section} 必须是 object。`);
    }
    for (const [name, spec] of Object.entries(entry[section])) {
      if (!PACKAGE_COMPONENT.test(name) && !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name)) {
        fail("NPM_LOCK_DEPENDENCY_NAME", `package-lock.json#packages.${packagePath}.${section} 包含非法包名。`);
      }
      validateRegistrySpec(spec, `package-lock.json#packages.${packagePath}.${section}.${name}`);
    }
  }
}

function packageNameFromPath(packagePath) {
  if (
    typeof packagePath !== "string"
    || packagePath.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(packagePath)
  ) {
    fail("NPM_LOCK_PACKAGE_PATH", "package-lock.json 包路径包含非法字符。" );
  }
  const segments = packagePath.split("/");
  let index = 0;
  let packageName = null;
  while (index < segments.length) {
    if (segments[index] !== "node_modules") {
      fail("NPM_LOCK_PACKAGE_PATH", "package-lock.json 包路径不是规范 node_modules 路径。" );
    }
    index += 1;
    if (SCOPE_COMPONENT.test(segments[index] ?? "")) {
      const scope = segments[index];
      const name = segments[index + 1];
      if (!PACKAGE_COMPONENT.test(name ?? "")) {
        fail("NPM_LOCK_PACKAGE_PATH", "package-lock.json scoped 包路径不完整。" );
      }
      packageName = `${scope}/${name}`;
      index += 2;
    } else {
      const name = segments[index];
      if (!PACKAGE_COMPONENT.test(name ?? "")) {
        fail("NPM_LOCK_PACKAGE_PATH", "package-lock.json 包路径不完整。" );
      }
      packageName = name;
      index += 1;
    }
  }
  return packageName;
}

function validateResolved(resolved, packagePath, packageName, version) {
  let url;
  try {
    url = new URL(resolved);
  } catch {
    fail("NPM_LOCK_RESOLVED", `package-lock.json#packages.${packagePath}.resolved 不是合法 URL。`);
  }
  if (
    url.origin !== OFFICIAL_REGISTRY.slice(0, -1)
    || url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    fail("NPM_LOCK_REGISTRY", `package-lock.json#packages.${packagePath}.resolved 不是官方 registry 来源。`);
  }
  const unscopedName = packageName.includes("/") ? packageName.split("/")[1] : packageName;
  const expectedPath = `/${packageName}/-/${unscopedName}-${version}.tgz`;
  if (url.pathname !== expectedPath) {
    fail("NPM_LOCK_TARBALL_IDENTITY", `package-lock.json#packages.${packagePath}.resolved 与包身份不一致。`);
  }
}

function validateIntegrity(integrity, packagePath) {
  const match = SHA512_INTEGRITY.exec(integrity ?? "");
  if (!match) {
    fail("NPM_LOCK_INTEGRITY", `package-lock.json#packages.${packagePath}.integrity 必须是 SHA-512 SRI。`);
  }
  const digest = Buffer.from(match[1], "base64");
  if (digest.length !== 64 || digest.toString("base64") !== match[1]) {
    fail("NPM_LOCK_INTEGRITY", `package-lock.json#packages.${packagePath}.integrity 编码无效。`);
  }
  return {
    algorithm: "SHA512",
    checksumValue: digest.toString("hex"),
  };
}

function spdxPackageId(name, version) {
  const id = `SPDXRef-Package-${name.replace(/^@/, "").replaceAll("/", ".")}-${version}`;
  if (!/^SPDXRef-[A-Za-z0-9.-]+$/.test(id)) {
    fail("NPM_LOCK_SPDX_ID", `${name}@${version} 无法投影为合法 SPDXID。`);
  }
  return id;
}

function npmPurl(name, version) {
  const encodedName = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encodedName}@${version}`;
}

function parentPackagePath(packagePath) {
  const boundary = packagePath.lastIndexOf("/node_modules/");
  return boundary === -1 ? "" : packagePath.slice(0, boundary);
}

function resolveDependencyPath(packages, sourcePath, dependencyName) {
  let ancestor = sourcePath;
  while (true) {
    const candidate = `${ancestor ? `${ancestor}/` : ""}node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (ancestor === "") return null;
    ancestor = parentPackagePath(ancestor);
  }
}

export function validateLockfileObject(lockfile, manifest) {
  if (lockfile.lockfileVersion !== 3) {
    fail("NPM_LOCK_VERSION", "package-lock.json#lockfileVersion 必须精确为 3。" );
  }
  if (lockfile.packages === null || typeof lockfile.packages !== "object" || Array.isArray(lockfile.packages)) {
    fail("NPM_LOCK_PACKAGES", "package-lock.json#packages 必须是 object。" );
  }
  const rootPackage = lockfile.packages[""];
  if (rootPackage === null || typeof rootPackage !== "object" || Array.isArray(rootPackage)) {
    fail("NPM_LOCK_ROOT", "package-lock.json#packages 必须包含根包记录。" );
  }
  if (
    typeof manifest.name !== "string"
    || typeof manifest.version !== "string"
    || lockfile.name !== manifest.name
    || lockfile.version !== manifest.version
    || rootPackage.name !== manifest.name
    || rootPackage.version !== manifest.version
  ) {
    fail("NPM_LOCK_ROOT_IDENTITY", "package-lock.json 顶层与根包身份必须精确绑定 package.json。" );
  }

  const expectedDependencies = stableValue(manifestDependencySnapshot(manifest));
  const actualDependencies = stableValue(manifestDependencySnapshot(rootPackage));
  if (JSON.stringify(actualDependencies) !== JSON.stringify(expectedDependencies)) {
    fail("NPM_LOCK_MANIFEST_DRIFT", "package-lock.json 根依赖声明与 package.json 不一致。" );
  }
  validateEntryDependencySources(rootPackage, "");

  for (const [packagePath, entry] of Object.entries(lockfile.packages)) {
    if (packagePath === "") continue;
    const packageName = packageNameFromPath(packagePath);
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || entry.link === true) {
      fail("NPM_LOCK_PACKAGE_ENTRY", `package-lock.json#packages.${packagePath} 不是 registry 包记录。`);
    }
    if (typeof entry.version !== "string" || !EXACT_PACKAGE_VERSION.test(entry.version)) {
      fail("NPM_LOCK_PACKAGE_VERSION", `package-lock.json#packages.${packagePath}.version 不是精确 registry 版本。`);
    }
    if (entry.name !== undefined && entry.name !== packageName) {
      fail("NPM_LOCK_PACKAGE_NAME", `package-lock.json#packages.${packagePath}.name 与路径身份不一致。`);
    }
    validateEntryDependencySources(entry, packagePath);
    validateResolved(entry.resolved, packagePath, packageName, entry.version);
    validateIntegrity(entry.integrity, packagePath);
  }
  return lockfile;
}

export function readAndValidateLockfile(root, manifest) {
  return readAndValidateLockfileSource(root, manifest).lockfile;
}

export function readAndValidateLockfileSource(root, manifest) {
  const text = readRegularProjectFile(root, "package-lock.json", "NPM_LOCK_FILE");
  return {
    lockfile: validateLockfileObject(parseLockfile(text), manifest),
    text,
  };
}

export function buildExpectedSpdxGraph(lockfile, manifest) {
  const validated = validateLockfileObject(lockfile, manifest);
  const packages = [];
  const packageIdsByPath = new Map();
  for (const [packagePath, entry] of Object.entries(validated.packages)) {
    if (packagePath === "") {
      const SPDXID = spdxPackageId(manifest.name, manifest.version);
      packages.push({
        SPDXID,
        checksums: [],
        downloadLocation: "NOASSERTION",
        name: manifest.name,
        packageFileName: "",
        purl: npmPurl(manifest.name, manifest.version),
        versionInfo: manifest.version,
      });
      packageIdsByPath.set(packagePath, SPDXID);
      continue;
    }
    const name = packageNameFromPath(packagePath);
    const SPDXID = spdxPackageId(name, entry.version);
    packages.push({
      SPDXID,
      checksums: [validateIntegrity(entry.integrity, packagePath)],
      downloadLocation: entry.resolved,
      name,
      packageFileName: packagePath,
      purl: npmPurl(name, entry.version),
      versionInfo: entry.version,
    });
    packageIdsByPath.set(packagePath, SPDXID);
  }
  packages.sort((left, right) => Buffer.compare(
    Buffer.from(left.SPDXID, "utf8"),
    Buffer.from(right.SPDXID, "utf8"),
  ));
  for (let index = 1; index < packages.length; index += 1) {
    if (packages[index - 1].SPDXID === packages[index].SPDXID) {
      fail("NPM_LOCK_SPDX_ID", `${packages[index].SPDXID} 在 lock 投影中重复。`);
    }
  }
  const relationshipsByIdentity = new Map();
  relationshipsByIdentity.set(
    `SPDXRef-DOCUMENT\0DESCRIBES\0${packageIdsByPath.get("")}`,
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: packageIdsByPath.get(""),
    },
  );
  for (const [sourcePath, entry] of Object.entries(validated.packages)) {
    const edges = new Map();
    const peerMeta = entry.peerDependenciesMeta ?? {};
    if (peerMeta === null || typeof peerMeta !== "object" || Array.isArray(peerMeta)) {
      fail("NPM_LOCK_PEER_META", `package-lock.json#packages.${sourcePath}.peerDependenciesMeta 必须是 object。`);
    }
    for (const dependencyName of Object.keys(entry.peerDependencies ?? {})) {
      const meta = peerMeta[dependencyName];
      if (
        meta !== undefined
        && (
          meta === null
          || typeof meta !== "object"
          || Array.isArray(meta)
          || Object.keys(meta).some((key) => key !== "optional")
          || (meta.optional !== undefined && typeof meta.optional !== "boolean")
        )
      ) {
        fail("NPM_LOCK_PEER_META", `package-lock.json#packages.${sourcePath}.peerDependenciesMeta.${dependencyName} 非法。`);
      }
      edges.set(dependencyName, {
        relationshipType: meta?.optional === true ? "DEPENDENCY_OF" : "PREREQUISITE_FOR",
        required: meta?.optional !== true,
      });
    }
    for (const dependencyName of Object.keys(entry.dependencies ?? {})) {
      edges.set(dependencyName, { relationshipType: "DEPENDENCY_OF", required: true });
    }
    for (const dependencyName of Object.keys(entry.optionalDependencies ?? {})) {
      edges.set(dependencyName, { relationshipType: "OPTIONAL_DEPENDENCY_OF", required: false });
    }
    if (sourcePath === "") {
      for (const dependencyName of Object.keys(entry.devDependencies ?? {})) {
        edges.set(dependencyName, { relationshipType: "DEV_DEPENDENCY_OF", required: true });
      }
    }
    for (const [dependencyName, edge] of edges) {
      const targetPath = resolveDependencyPath(validated.packages, sourcePath, dependencyName);
      if (targetPath === null) {
        if (edge.required) {
          fail(
            "NPM_LOCK_DEPENDENCY_MISSING",
            `package-lock.json#packages.${sourcePath} 的必需依赖 ${dependencyName} 缺少锁定节点。`,
          );
        }
        continue;
      }
      const relationship = {
        spdxElementId: packageIdsByPath.get(targetPath),
        relationshipType: edge.relationshipType,
        relatedSpdxElement: packageIdsByPath.get(sourcePath),
      };
      relationshipsByIdentity.set(
        `${relationship.spdxElementId}\0${relationship.relatedSpdxElement}`,
        relationship,
      );
    }
  }
  const relationships = [...relationshipsByIdentity.values()].sort((left, right) => Buffer.compare(
    Buffer.from(`${left.spdxElementId}\0${left.relationshipType}\0${left.relatedSpdxElement}`, "utf8"),
    Buffer.from(`${right.spdxElementId}\0${right.relationshipType}\0${right.relatedSpdxElement}`, "utf8"),
  ));
  return { packages, relationships };
}

export function hashProjectFile(root, relativePath, { optional = false } = {}) {
  if (optional && !existsSync(resolve(root, relativePath))) return null;
  const text = readRegularProjectFile(root, relativePath, "NPM_INPUT_FILE");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

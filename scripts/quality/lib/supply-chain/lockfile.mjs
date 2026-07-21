import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { OFFICIAL_REGISTRY, ROOT_DEPENDENCY_OVERRIDES } from "./contracts.mjs";
import { manifestDependencySnapshot, readRegularProjectFile } from "./config.mjs";
import { fail } from "./errors.mjs";

const EXACT_PACKAGE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA512_INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const PACKAGE_COMPONENT = /^[a-z0-9][a-z0-9._-]*$/;
const SCOPE_COMPONENT = /^@[a-z0-9][a-z0-9._-]*$/;
// npm 11.16.0 先以 @isaacs/string-locale-compare("en") 排 location，再按 SPDXID 取首项。
const NPM_LOCATION_COLLATOR = new Intl.Collator("en");

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

function isPackageName(name) {
  return PACKAGE_COMPONENT.test(name)
    || /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name);
}

function parseExactRegistryAlias(spec, fieldPath) {
  const target = spec.slice("npm:".length);
  const versionSeparator = target.lastIndexOf("@");
  const name = target.slice(0, versionSeparator);
  const version = target.slice(versionSeparator + 1);
  if (
    versionSeparator <= 0
    || !isPackageName(name)
    || !EXACT_PACKAGE_VERSION.test(version)
  ) {
    fail(
      "NPM_LOCK_DEPENDENCY_SOURCE",
      `${fieldPath} 只允许绑定精确 name@version 的 registry alias。`,
    );
  }
  return { name, version };
}

function validateRegistrySpec(spec, fieldPath, { allowExactAlias = false } = {}) {
  if (
    typeof spec !== "string"
    || spec.trim() !== spec
    || spec === ""
    || /[\u0000-\u001f\u007f]/.test(spec)
  ) {
    fail("NPM_LOCK_DEPENDENCY_SOURCE", `${fieldPath} 不是 registry 依赖表达。`);
  }
  if (spec.startsWith("npm:")) {
    if (!allowExactAlias) {
      fail("NPM_LOCK_DEPENDENCY_SOURCE", `${fieldPath} 不允许 registry alias。`);
    }
    return parseExactRegistryAlias(spec, fieldPath);
  }
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(spec)
    || spec.startsWith(".")
    || spec.startsWith("/")
    || spec.startsWith("\\")
    || spec.includes("/")
    || spec.includes("://")
    || spec.startsWith("git@")
    || /(?:^|[\\/])[^\\/]+\.(?:tgz|tar|tar\.gz|zip)$/i.test(spec)
  ) {
    fail("NPM_LOCK_DEPENDENCY_SOURCE", `${fieldPath} 不是 registry 依赖表达。`);
  }
  return null;
}

function validateEntryDependencySources(entry, packagePath) {
  const declarations = [];
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (entry[section] === undefined) continue;
    if (entry[section] === null || typeof entry[section] !== "object" || Array.isArray(entry[section])) {
      fail("NPM_LOCK_DEPENDENCY_SECTION", `package-lock.json#packages.${packagePath}.${section} 必须是 object。`);
    }
    for (const [name, spec] of Object.entries(entry[section])) {
      if (!isPackageName(name)) {
        fail("NPM_LOCK_DEPENDENCY_NAME", `package-lock.json#packages.${packagePath}.${section} 包含非法包名。`);
      }
      const alias = validateRegistrySpec(
        spec,
        `package-lock.json#packages.${packagePath}.${section}.${name}`,
        { allowExactAlias: packagePath !== "" },
      );
      declarations.push({ alias, dependencyName: name, section, sourcePath: packagePath });
    }
  }
  return declarations;
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

function lockedPackageName(packagePath, entry) {
  const locationName = packageNameFromPath(packagePath);
  if (entry.name === undefined) return locationName;
  if (!isPackageName(entry.name)) {
    fail("NPM_LOCK_PACKAGE_NAME", `package-lock.json#packages.${packagePath}.name 不是合法包名。`);
  }
  return entry.name;
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

export function npmNativeSpdxPackageId(name, version) {
  return `SPDXRef-Package-${name.replace(/^@/, "").replaceAll("/", ".")}-${version}`;
}

export function spdxPackageId(name, version) {
  const id = npmNativeSpdxPackageId(name, version).replace(/[^A-Za-z0-9.-]/gu, "-");
  if (!/^SPDXRef-[A-Za-z0-9.-]+$/.test(id)) {
    fail("NPM_LOCK_SPDX_ID", `${name}@${version} 无法投影为合法 SPDXID。`);
  }
  return id;
}

function npmPurl(name, version) {
  const encodedName = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encodedName}@${version}`;
}

export function exactPackageIdentity(name, version) {
  if (
    !isPackageName(name)
    || typeof version !== "string"
    || !EXACT_PACKAGE_VERSION.test(version)
  ) {
    fail("NPM_LOCK_PACKAGE_IDENTITY", "依赖身份必须是合法的精确 name@version。");
  }
  return `${name}@${version}`;
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

function aliasContractIdentity(dependencyName, packageName, version) {
  return `${dependencyName}\u0000${packageName}\u0000${version}`;
}

export function validateLockfileObject(lockfile, manifest, { allowOverrideDrift = false } = {}) {
  if (typeof allowOverrideDrift !== "boolean") {
    fail("NPM_LOCK_OPTIONS", "package-lock.json 校验选项不合法。");
  }
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
  const dependencyDeclarations = validateEntryDependencySources(rootPackage, "");
  const aliasedPackagePaths = new Set();
  const activeAliasContracts = new Set();
  const enforceRootOverrides = manifest.overrides !== undefined;
  const overrideCounts = Object.fromEntries(
    Object.keys(ROOT_DEPENDENCY_OVERRIDES).map((name) => [name, 0]),
  );

  for (const [packagePath, entry] of Object.entries(lockfile.packages)) {
    if (packagePath === "") continue;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || entry.link === true) {
      fail("NPM_LOCK_PACKAGE_ENTRY", `package-lock.json#packages.${packagePath} 不是 registry 包记录。`);
    }
    if (typeof entry.version !== "string" || !EXACT_PACKAGE_VERSION.test(entry.version)) {
      fail("NPM_LOCK_PACKAGE_VERSION", `package-lock.json#packages.${packagePath}.version 不是精确 registry 版本。`);
    }
    const packageName = lockedPackageName(packagePath, entry);
    if (enforceRootOverrides && Object.hasOwn(ROOT_DEPENDENCY_OVERRIDES, packageName)) {
      if (!allowOverrideDrift && entry.version !== ROOT_DEPENDENCY_OVERRIDES[packageName]) {
        fail(
          "NPM_LOCK_OVERRIDE_DRIFT",
          `package-lock.json 中 ${packageName} 没有闭合到 D-082 精确覆盖版本。`,
        );
      }
      overrideCounts[packageName] += 1;
    }
    dependencyDeclarations.push(...validateEntryDependencySources(entry, packagePath));
    validateResolved(entry.resolved, packagePath, packageName, entry.version);
    validateIntegrity(entry.integrity, packagePath);
  }

  for (const [name, count] of enforceRootOverrides ? Object.entries(overrideCounts) : []) {
    if (count === 0) {
      fail("NPM_LOCK_OVERRIDE_MISSING", `package-lock.json 未消费 D-082 覆盖 ${name}。`);
    }
  }

  for (const declaration of dependencyDeclarations.filter(({ alias }) => alias !== null)) {
    const targetPath = resolveDependencyPath(
      lockfile.packages,
      declaration.sourcePath,
      declaration.dependencyName,
    );
    if (targetPath === null) continue;
    const targetEntry = lockfile.packages[targetPath];
    const targetName = lockedPackageName(targetPath, targetEntry);
    if (
      targetName !== declaration.alias.name
      || targetEntry.version !== declaration.alias.version
    ) {
      fail(
        "NPM_LOCK_PACKAGE_NAME",
        `package-lock.json#packages.${targetPath} 与精确 registry alias 目标不一致。`,
      );
    }
    activeAliasContracts.add(aliasContractIdentity(
      declaration.dependencyName,
      targetName,
      targetEntry.version,
    ));
    aliasedPackagePaths.add(targetPath);
  }

  for (const declaration of dependencyDeclarations.filter(({ alias }) => alias === null)) {
    const targetPath = resolveDependencyPath(
      lockfile.packages,
      declaration.sourcePath,
      declaration.dependencyName,
    );
    if (targetPath === null) continue;
    const targetEntry = lockfile.packages[targetPath];
    const targetName = lockedPackageName(targetPath, targetEntry);
    if (
      targetName !== declaration.dependencyName
      && !activeAliasContracts.has(aliasContractIdentity(
        declaration.dependencyName,
        targetName,
        targetEntry.version,
      ))
    ) {
      fail(
        "NPM_LOCK_PACKAGE_NAME",
        `package-lock.json#packages.${targetPath}.name 未由精确 registry alias 绑定。`,
      );
    }
  }

  for (const [packagePath, entry] of Object.entries(lockfile.packages)) {
    if (packagePath === "") continue;
    const locationName = packageNameFromPath(packagePath);
    const packageName = lockedPackageName(packagePath, entry);
    if (packageName === locationName || aliasedPackagePaths.has(packagePath)) continue;
    if (!activeAliasContracts.has(aliasContractIdentity(
      locationName,
      packageName,
      entry.version,
    ))) {
      fail(
        "NPM_LOCK_PACKAGE_NAME",
        `package-lock.json#packages.${packagePath}.name 未由精确 registry alias 引用。`,
      );
    }
  }
  return lockfile;
}

export function readAndValidateLockfile(root, manifest, options = {}) {
  return readAndValidateLockfileSource(root, manifest, options).lockfile;
}

export function readAndValidateLockfileSource(root, manifest, options = {}) {
  const text = readRegularProjectFile(root, "package-lock.json", "NPM_LOCK_FILE");
  return {
    lockfile: validateLockfileObject(parseLockfile(text), manifest, options),
    text,
  };
}

export function collectLockedPackages(lockfile, manifest) {
  const validated = validateLockfileObject(lockfile, manifest);
  const byIdentity = new Map();
  for (const [packagePath, entry] of Object.entries(validated.packages)) {
    if (packagePath === "") continue;
    if (entry.hasInstallScript !== undefined && typeof entry.hasInstallScript !== "boolean") {
      fail(
        "NPM_LOCK_INSTALL_SCRIPT",
        `package-lock.json#packages.${packagePath}.hasInstallScript 必须是 boolean。`,
      );
    }
    const name = lockedPackageName(packagePath, entry);
    const identity = exactPackageIdentity(name, entry.version);
    const current = {
      identity,
      name,
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      hasInstallScript: entry.hasInstallScript === true,
      paths: [packagePath],
    };
    const previous = byIdentity.get(identity);
    if (!previous) {
      byIdentity.set(identity, current);
      continue;
    }
    if (
      previous.resolved !== current.resolved
      || previous.integrity !== current.integrity
      || previous.hasInstallScript !== current.hasInstallScript
    ) {
      fail(
        "NPM_LOCK_PACKAGE_IDENTITY",
        `${identity} 的重复锁定节点没有绑定同一 tarball 与脚本标记。`,
      );
    }
    previous.paths.push(packagePath);
  }
  return [...byIdentity.values()]
    .map((package_) => ({
      ...package_,
      paths: package_.paths.sort((left, right) => Buffer.compare(
        Buffer.from(left, "utf8"),
        Buffer.from(right, "utf8"),
      )),
    }))
    .sort((left, right) => Buffer.compare(
      Buffer.from(left.identity, "utf8"),
      Buffer.from(right.identity, "utf8"),
    ));
}

function validateTarballMetadata(metadata, identity) {
  if (
    metadata === null
    || typeof metadata !== "object"
    || Array.isArray(metadata)
    || metadata.identity !== identity
    || typeof metadata.licenseDeclared !== "string"
    || metadata.licenseDeclared.length === 0
    || typeof metadata.homepage !== "string"
    || metadata.homepage.length === 0
    || (
      metadata.description !== null
      && typeof metadata.description !== "string"
    )
  ) {
    fail("NPM_LOCK_TARBALL_METADATA", `${identity} 的 tarball SPDX metadata 不合法。`);
  }
  return metadata;
}

export function buildExpectedSpdxGraph(lockfile, manifest, {
  packageMetadataByIdentity = null,
  requirePackageMetadata = false,
} = {}) {
  const validated = validateLockfileObject(lockfile, manifest);
  collectLockedPackages(validated, manifest);
  if (
    packageMetadataByIdentity !== null
    && !(packageMetadataByIdentity instanceof Map)
  ) {
    fail("NPM_LOCK_TARBALL_METADATA", "tarball SPDX metadata 必须使用 Map 按精确身份索引。" );
  }
  if (requirePackageMetadata && packageMetadataByIdentity === null) {
    fail("NPM_LOCK_TARBALL_METADATA", "生产 SPDX 图缺少 tarball metadata。" );
  }
  const packagesBySpdxId = new Map();
  const packageIdsByPath = new Map();
  const consumedMetadata = new Set();
  for (const [packagePath, entry] of Object.entries(validated.packages)) {
    if (packagePath === "") {
      const SPDXID = spdxPackageId(manifest.name, manifest.version);
      if (packagesBySpdxId.has(SPDXID)) {
        fail("NPM_LOCK_SPDX_ID", `${SPDXID} 被根包与依赖包共同使用。`);
      }
      packagesBySpdxId.set(SPDXID, {
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
    const name = lockedPackageName(packagePath, entry);
    const identity = exactPackageIdentity(name, entry.version);
    const metadata = packageMetadataByIdentity?.get(identity) ?? null;
    if (requirePackageMetadata && metadata === null) {
      fail("NPM_LOCK_TARBALL_METADATA", `${identity} 缺少 tarball metadata。`);
    }
    if (metadata !== null) {
      validateTarballMetadata(metadata, identity);
      consumedMetadata.add(identity);
    }
    const SPDXID = spdxPackageId(name, entry.version);
    const expectedPackage = {
      SPDXID,
      checksums: [validateIntegrity(entry.integrity, packagePath)],
      downloadLocation: entry.resolved,
      name,
      packageFileName: packagePath,
      purl: npmPurl(name, entry.version),
      versionInfo: entry.version,
    };
    if (metadata !== null) {
      // `npm sbom --package-lock-only` builds dependency nodes from lock v3 metadata.
      // The pinned Arborist lock projection retains license but not homepage/description.
      expectedPackage.description = null;
      expectedPackage.homepage = "NOASSERTION";
      expectedPackage.licenseDeclared = metadata.licenseDeclared;
    }
    const existingPackage = packagesBySpdxId.get(SPDXID);
    if (existingPackage !== undefined) {
      if (
        existingPackage.packageFileName === ""
        || expectedPackage.packageFileName === ""
        || existingPackage.name !== expectedPackage.name
        || existingPackage.versionInfo !== expectedPackage.versionInfo
      ) {
        fail("NPM_LOCK_SPDX_ID", `${SPDXID} 被不同精确包身份复用。`);
      }
      const locationOrder = NPM_LOCATION_COLLATOR.compare(
        expectedPackage.packageFileName,
        existingPackage.packageFileName,
      );
      if (
        locationOrder === 0
        && expectedPackage.packageFileName !== existingPackage.packageFileName
      ) {
        fail("NPM_LOCK_SPDX_ID", `${SPDXID} 的 npm location 排序身份不唯一。`);
      }
      if (locationOrder < 0) packagesBySpdxId.set(SPDXID, expectedPackage);
    } else {
      packagesBySpdxId.set(SPDXID, expectedPackage);
    }
    packageIdsByPath.set(packagePath, SPDXID);
  }
  if (
    packageMetadataByIdentity !== null
    && (
      consumedMetadata.size !== packageMetadataByIdentity.size
      || [...packageMetadataByIdentity.keys()].some((identity) => !consumedMetadata.has(identity))
    )
  ) {
    fail("NPM_LOCK_TARBALL_METADATA", "tarball metadata 包集合与 lock 不一致。" );
  }
  const packages = [...packagesBySpdxId.values()].sort((left, right) => Buffer.compare(
    Buffer.from(left.SPDXID, "utf8"),
    Buffer.from(right.SPDXID, "utf8"),
  ));
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
        `${relationship.spdxElementId}\0${relationship.relationshipType}\0${relationship.relatedSpdxElement}`,
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

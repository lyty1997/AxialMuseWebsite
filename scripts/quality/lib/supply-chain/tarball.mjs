import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { TextDecoder } from "node:util";
import { fail } from "./errors.mjs";
import { exactPackageIdentity } from "./lockfile.mjs";
import { assertNoDuplicateJsonKeys } from "./strict-json.mjs";

const BLOCK_SIZE = 512;
const END_BLOCKS_SIZE = BLOCK_SIZE * 2;
const INSTALL_EVENTS = Object.freeze(["preinstall", "install", "postinstall"]);
const SHA512_INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const SAFE_METADATA = /^[^\u0000-\u001f\u007f]+$/u;
const PAX_DECIMAL = /^(?:0|[1-9]\d*)$/;
const PAX_TIME = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const NODETAR_PAX_KEY = /^NODETAR\.(?:blksize|blocks|depth|follow|type|ignoreFiles\.(?:0|[1-9]\d*)|package(?:\.[A-Za-z0-9@_:+/-]+)+)$/;
const LICENSE_BASENAMES = Object.freeze([
  "copying",
  "licence",
  "licences",
  "license",
  "licenses",
  "third_party_licence",
  "third_party_licences",
  "third_party_license",
  "third_party_licenses",
]);
const NOTICE_BASENAMES = Object.freeze([
  "notice",
  "notices",
  "third_party_notice",
  "third_party_notices",
]);
const LEGAL_TEXT_EXTENSION = /^(?:0bsd|adoc|apache(?:[-_.]?2(?:\.0)?)?|asc|bsd(?:[-_.]?[234](?:[-_.]?clause)?)?|gpl(?:[-_.]?[0-9.]+)?|html?|isc|lgpl(?:[-_.]?[0-9.]+)?|markdown|md|mit|mpl(?:[-_.]?[0-9.]+)?|ofl(?:[-_.]?[0-9.]+)?|rst|txt|unlicense)$/i;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const PATH_INDEX_ENTRY_OVERHEAD = 64;
const LICENSE_METADATA_MAX_LENGTH = 200;
const HOMEPAGE_METADATA_MAX_LENGTH = 4096;
const PERSISTED_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export const TARBALL_LIMITS = Object.freeze({
  compressedBytes: 64 * 1024 * 1024,
  decompressedBytes: 256 * 1024 * 1024,
  entries: 50_000,
  legalFileBytes: 2 * 1024 * 1024,
  legalFiles: 64,
  legalTotalBytes: 16 * 1024 * 1024,
  packageJsonBytes: 1024 * 1024,
  pathBytes: 1024,
  pathDepth: 128,
  pathIndexBytes: 16 * 1024 * 1024,
  paxBytes: 64 * 1024,
  paxRecords: 64,
});

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function matchesLegalBasename(value, roots) {
  const basename = value.toLowerCase().replaceAll("-", "_");
  for (const root of roots) {
    if (basename === root) return true;
    for (const separator of ["-", "_"]) {
      if (basename.startsWith(`${root}${separator}`)) {
        const suffix = basename.slice(root.length + 1);
        if (/^[a-z0-9+_-]+$/i.test(suffix) || LEGAL_TEXT_EXTENSION.test(suffix)) return true;
      }
    }
    if (basename.startsWith(`${root}.`)) {
      const suffix = basename.slice(root.length + 1);
      if (LEGAL_TEXT_EXTENSION.test(suffix)) return true;
    }
  }
  return false;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasIsolatedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isAllZero(buffer) {
  for (const byte of buffer) {
    if (byte !== 0) return false;
  }
  return true;
}

function decodeUtf8(buffer, code, label) {
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    fail(code, `${label} 不是合法 UTF-8。`);
  }
}

function parseOctalField(field, label, {
  allowBase256 = false,
  allowEmpty = false,
} = {}) {
  if ((field[0] & 0x80) !== 0) {
    if (!allowBase256 || (field[0] & 0xc0) !== 0x80) {
      fail("SUPPLY_CHAIN_TARBALL_NUMBER", `${label} 不允许该 base-256 编码。`);
    }
    let value = BigInt(field[0] & 0x3f);
    for (const byte of field.subarray(1)) value = (value << 8n) + BigInt(byte);
    return value;
  }
  for (const byte of field) {
    if (byte !== 0 && byte !== 0x20 && (byte < 0x30 || byte > 0x37)) {
      fail("SUPPLY_CHAIN_TARBALL_NUMBER", `${label} 不是合法八进制字段。`);
    }
  }
  const firstNull = field.indexOf(0);
  const prefix = firstNull === -1 ? field : field.subarray(0, firstNull);
  if (firstNull !== -1) {
    for (const byte of field.subarray(firstNull + 1)) {
      if (byte !== 0 && byte !== 0x20) {
        fail("SUPPLY_CHAIN_TARBALL_NUMBER", `${label} 在终止符后包含数据。`);
      }
    }
  }
  const digits = prefix.toString("ascii").trim();
  if (digits === "") {
    if (allowEmpty) return 0n;
    fail("SUPPLY_CHAIN_TARBALL_NUMBER", `${label} 不能为空。`);
  }
  if (!/^[0-7]+$/.test(digits)) {
    fail("SUPPLY_CHAIN_TARBALL_NUMBER", `${label} 不是连续八进制数字。`);
  }
  let value = 0n;
  for (const digit of digits) value = value * 8n + BigInt(digit.charCodeAt(0) - 0x30);
  return value;
}

function decodeHeaderString(field, label) {
  const firstNull = field.indexOf(0);
  const value = firstNull === -1 ? field : field.subarray(0, firstNull);
  if (firstNull !== -1 && !isAllZero(field.subarray(firstNull + 1))) {
    fail("SUPPLY_CHAIN_TARBALL_HEADER", `${label} 在 NUL 终止符后包含数据。`);
  }
  return decodeUtf8(value, "SUPPLY_CHAIN_TARBALL_HEADER", label);
}

function decodePosixPrefix(field) {
  const firstNull = field.indexOf(0);
  if (firstNull === -1 || isAllZero(field.subarray(firstNull + 1))) {
    return decodeHeaderString(field, "tar header prefix");
  }
  const starAtime = field.subarray(131, 143);
  const starCtime = field.subarray(143, 155);
  if (
    isAllZero(field.subarray(0, 131))
    && /^[0-7]{11}\0$/.test(starAtime.toString("binary"))
    && /^[0-7]{11}\0$/.test(starCtime.toString("binary"))
  ) {
    return "";
  }
  fail("SUPPLY_CHAIN_TARBALL_HEADER", "tar header prefix 在 NUL 终止符后包含数据。");
}

function validateHeaderChecksum(block) {
  const stored = parseOctalField(
    block.subarray(148, 156),
    "tar header checksum",
  );
  let computed = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    computed += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (stored !== BigInt(computed)) {
    fail("SUPPLY_CHAIN_TARBALL_CHECKSUM", "tar header checksum 不匹配。" );
  }
}

function parseHeader(block) {
  validateHeaderChecksum(block);
  const posix = block.subarray(257, 263).equals(Buffer.from("ustar\0", "binary"))
    && block.subarray(263, 265).equals(Buffer.from("00", "ascii"));
  const gnu = block.subarray(257, 263).equals(Buffer.from("ustar ", "ascii"))
    && block.subarray(263, 265).equals(Buffer.from([0x20, 0x00]));
  if (!posix && !gnu) {
    fail("SUPPLY_CHAIN_TARBALL_FORMAT", "tar header 不是受控 POSIX/GNU ustar 格式。" );
  }

  const name = decodeHeaderString(block.subarray(0, 100), "tar header name");
  const prefix = posix
    ? decodePosixPrefix(block.subarray(345, 500))
    : "";
  if (name === "") {
    fail("SUPPLY_CHAIN_TARBALL_HEADER", "非零 tar header 的 name 不能为空。" );
  }
  const path = prefix === "" ? name : `${prefix}/${name}`;
  const sizeValue = parseOctalField(block.subarray(124, 136), "tar header size");
  if (sizeValue > BigInt(TARBALL_LIMITS.decompressedBytes)) {
    fail("SUPPLY_CHAIN_TARBALL_LIMIT", "tar entry size 超过审查上限。" );
  }
  const mode = parseOctalField(block.subarray(100, 108), "tar header mode", { allowEmpty: true });
  parseOctalField(block.subarray(108, 116), "tar header uid", {
    allowBase256: true,
    allowEmpty: true,
  });
  parseOctalField(block.subarray(116, 124), "tar header gid", {
    allowBase256: true,
    allowEmpty: true,
  });
  parseOctalField(block.subarray(136, 148), "tar header mtime", { allowEmpty: true });
  parseOctalField(block.subarray(329, 337), "tar header devmajor", { allowEmpty: true });
  parseOctalField(block.subarray(337, 345), "tar header devminor", { allowEmpty: true });
  if ((mode & 0o7000n) !== 0n) {
    fail("SUPPLY_CHAIN_TARBALL_MODE", "tar entry 不允许 setuid、setgid 或 sticky mode。" );
  }
  const typeByte = block[156];
  const type = typeByte === 0 ? "\0" : String.fromCharCode(typeByte);
  const linkname = decodeHeaderString(block.subarray(157, 257), "tar header linkname");
  return {
    format: posix ? "posix" : "gnu",
    linkname,
    path,
    size: Number(sizeValue),
    type,
  };
}

function assertExtensionHeaderPath(path, type) {
  if (
    path === ""
    || path.startsWith("/")
    || path.startsWith("\\")
    || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    fail("SUPPLY_CHAIN_TARBALL_PATH", `${type} 扩展 header path 非法。`);
  }
  if (type === "GNU longname") {
    if (path !== "././@LongLink") {
      fail("SUPPLY_CHAIN_TARBALL_LONGNAME", "GNU longname header name 必须精确为 ././@LongLink。" );
    }
    return;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("SUPPLY_CHAIN_TARBALL_PATH", "PAX header path 包含非规范分段。" );
  }
}

function assertPaxSafeText(value, key, { allowEmpty = false } = {}) {
  if (
    (!allowEmpty && value === "")
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("SUPPLY_CHAIN_TARBALL_PAX", `PAX ${key} 值非法。`);
  }
}

function parsePaxPayload(payload) {
  if (payload.length === 0 || payload.length > TARBALL_LIMITS.paxBytes) {
    fail("SUPPLY_CHAIN_TARBALL_LIMIT", "PAX payload 为空或超过审查上限。" );
  }
  const values = Object.create(null);
  let offset = 0;
  let records = 0;
  while (offset < payload.length) {
    records += 1;
    if (records > TARBALL_LIMITS.paxRecords) {
      fail("SUPPLY_CHAIN_TARBALL_LIMIT", "PAX record 数超过审查上限。" );
    }
    const space = payload.indexOf(0x20, offset);
    if (space === -1) {
      fail("SUPPLY_CHAIN_TARBALL_PAX", "PAX record 缺少长度分隔符。" );
    }
    const lengthBytes = payload.subarray(offset, space);
    if ([...lengthBytes].some((byte) => byte < 0x30 || byte > 0x39)) {
      fail("SUPPLY_CHAIN_TARBALL_PAX", "PAX record length 必须是 ASCII 十进制。" );
    }
    const lengthText = lengthBytes.toString("ascii");
    if (!/^[1-9]\d*$/.test(lengthText)) {
      fail("SUPPLY_CHAIN_TARBALL_PAX", "PAX record length 不是规范十进制。" );
    }
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 1) {
      fail("SUPPLY_CHAIN_TARBALL_PAX", "PAX record length 非法。" );
    }
    const end = offset + length;
    if (end > payload.length || payload[end - 1] !== 0x0a) {
      fail("SUPPLY_CHAIN_TARBALL_PAX", "PAX record length 与 payload 不一致。" );
    }
    const record = payload.subarray(space + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) {
      fail("SUPPLY_CHAIN_TARBALL_PAX", "PAX record 缺少 key=value。" );
    }
    const keyBytes = record.subarray(0, equals);
    if ([...keyBytes].some((byte) => byte > 0x7f)) {
      fail("SUPPLY_CHAIN_TARBALL_PAX", "PAX key 必须是 ASCII。" );
    }
    const key = keyBytes.toString("ascii");
    const nodeTarMetadata = NODETAR_PAX_KEY.test(key);
    if (
      !nodeTarMetadata
      && !/^(?:path|size|mtime|atime|ctime|uid|gid|uname|gname|charset|comment|SCHILY\.(?:dev|ino|nlink))$/.test(key)
    ) {
      fail("SUPPLY_CHAIN_TARBALL_PAX", "PAX key 不在受控子集中。" );
    }
    if (Object.hasOwn(values, key)) {
      fail("SUPPLY_CHAIN_TARBALL_PAX", `PAX key ${key} 重复。`);
    }
    const value = decodeUtf8(
      record.subarray(equals + 1),
      "SUPPLY_CHAIN_TARBALL_PAX",
      `PAX ${key}`,
    );
    if (nodeTarMetadata) {
      assertPaxSafeText(value, key, { allowEmpty: true });
      values[key] = value;
    } else if (key === "path") {
      assertPaxSafeText(value, key);
      values.path = value;
    } else if (key === "size") {
      if (!PAX_DECIMAL.test(value)) {
        fail("SUPPLY_CHAIN_TARBALL_PAX", "PAX size 不是规范非负十进制。" );
      }
      const size = BigInt(value);
      if (size > BigInt(TARBALL_LIMITS.decompressedBytes)) {
        fail("SUPPLY_CHAIN_TARBALL_LIMIT", "PAX size 超过审查上限。" );
      }
      values.size = Number(size);
    } else if (["mtime", "atime", "ctime"].includes(key)) {
      if (!PAX_TIME.test(value)) {
        fail("SUPPLY_CHAIN_TARBALL_PAX", `PAX ${key} 不是规范时间数值。`);
      }
      values[key] = value;
    } else if (["uid", "gid", "SCHILY.dev", "SCHILY.ino", "SCHILY.nlink"].includes(key)) {
      if (!PAX_DECIMAL.test(value)) {
        fail("SUPPLY_CHAIN_TARBALL_PAX", `PAX ${key} 不是规范非负整数。`);
      }
      values[key] = value;
    } else if (key === "charset") {
      if (value !== "UTF-8") {
        fail("SUPPLY_CHAIN_TARBALL_PAX", "PAX charset 只允许 UTF-8。" );
      }
      values.charset = value;
    } else {
      assertPaxSafeText(value, key, { allowEmpty: true });
      values[key] = value;
    }
    offset = end;
  }
  return values;
}

function parseLongnamePayload(payload) {
  if (payload.length < 2 || payload.length > TARBALL_LIMITS.paxBytes) {
    fail("SUPPLY_CHAIN_TARBALL_LIMIT", "GNU longname payload 为空或超过审查上限。" );
  }
  const firstNull = payload.indexOf(0);
  if (firstNull <= 0 || !isAllZero(payload.subarray(firstNull))) {
    fail("SUPPLY_CHAIN_TARBALL_LONGNAME", "GNU longname 必须由 NUL 终止且尾部只能包含 NUL。" );
  }
  return decodeUtf8(
    payload.subarray(0, firstNull),
    "SUPPLY_CHAIN_TARBALL_LONGNAME",
    "GNU longname",
  );
}

function validateFinalPath(path, type, allowedRoots, activeRoot) {
  const byteLength = Buffer.byteLength(path, "utf8");
  if (byteLength === 0 || byteLength > TARBALL_LIMITS.pathBytes) {
    fail("SUPPLY_CHAIN_TARBALL_LIMIT", "tar 最终路径为空或超过审查上限。" );
  }
  if (
    path.startsWith("/")
    || path.startsWith("\\")
    || path.includes("\\")
    || /^[A-Za-z]:/.test(path)
    || /[\u0000-\u001f\u007f]/u.test(path)
    || path.includes("//")
  ) {
    fail("SUPPLY_CHAIN_TARBALL_PATH", `tar 最终路径 ${JSON.stringify(path)} 非法。`);
  }
  if (type === "file" && path.endsWith("/")) {
    fail("SUPPLY_CHAIN_TARBALL_PATH", "regular file path 不得以 / 结尾。" );
  }
  const canonical = type === "directory" && path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = canonical.split("/");
  const archiveRoot = segments[0];
  const nodeModulesIndex = segments.indexOf("node_modules", 1);
  const ignoredResolverFixture = nodeModulesIndex >= 2
    && segments[1] === "test"
    && nodeModulesIndex < segments.length - 1
    && type === "file"
    && segments.at(-1).endsWith(".js");
  if (
    segments.length > TARBALL_LIMITS.pathDepth
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
    || !allowedRoots.has(archiveRoot)
    || (activeRoot !== null && archiveRoot !== activeRoot)
    || (nodeModulesIndex !== -1 && !ignoredResolverFixture)
    || canonical.normalize("NFC") !== canonical
    || (segments.length === 1 && type !== "directory")
  ) {
    fail("SUPPLY_CHAIN_TARBALL_PATH", `tar 最终路径 ${JSON.stringify(path)} 不在规范 package/ 根下。`);
  }
  return {
    archiveRoot,
    canonical: archiveRoot === "package"
      ? canonical
      : ["package", ...segments.slice(1)].join("/"),
  };
}

function assertSafeMetadataString(value, label, {
  allowEmpty = false,
  allowEdgeWhitespace = false,
  maxLength,
} = {}) {
  if (
    typeof value !== "string"
    || (!allowEmpty && value === "")
    || (!allowEdgeWhitespace && value.trim() !== value)
    || (allowEdgeWhitespace && value !== "" && value.trim() === "")
    || (maxLength !== undefined && value.length > maxLength)
    || hasIsolatedSurrogate(value)
    || (value !== "" && !SAFE_METADATA.test(value))
  ) {
    fail(
      "SUPPLY_CHAIN_TARBALL_MANIFEST",
      `package.json#${label} 不是受控${allowEmpty ? "" : "非空"}字符串。`,
    );
  }
  return value;
}

function parsePackageJson(bytes, expectedName, expectedVersion) {
  if (bytes.length === 0 || bytes.length > TARBALL_LIMITS.packageJsonBytes) {
    fail("SUPPLY_CHAIN_TARBALL_LIMIT", "package/package.json 为空或超过审查上限。" );
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail("SUPPLY_CHAIN_TARBALL_MANIFEST", "package/package.json 不允许 UTF-8 BOM。" );
  }
  const text = decodeUtf8(bytes, "SUPPLY_CHAIN_TARBALL_MANIFEST", "package/package.json");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    fail("SUPPLY_CHAIN_TARBALL_MANIFEST", "package/package.json 不是合法 JSON。" );
  }
  assertNoDuplicateJsonKeys(text, {
    depthCode: "SUPPLY_CHAIN_TARBALL_LIMIT",
    duplicateCode: "SUPPLY_CHAIN_TARBALL_MANIFEST_DUPLICATE",
    invalidCode: "SUPPLY_CHAIN_TARBALL_MANIFEST",
    label: "package.json",
  });
  if (!isPlainObject(manifest)) {
    fail("SUPPLY_CHAIN_TARBALL_MANIFEST", "package/package.json 顶层必须是 object。" );
  }
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    fail(
      "SUPPLY_CHAIN_TARBALL_IDENTITY",
      "tarball package.json 的 name/version 与 lock 精确身份不一致。",
    );
  }
  let licenseDeclared = manifest.license;
  if (licenseDeclared) {
    if (typeof licenseDeclared === "object") licenseDeclared = licenseDeclared.type;
  } else if (Array.isArray(manifest.licenses)) {
    licenseDeclared = manifest.licenses
      .map((license, index) => {
        const value = isPlainObject(license) ? license.type : license;
        if (value === undefined || value === null || value === "") return null;
        return assertSafeMetadataString(value, `licenses[${index}]`, {
          maxLength: LICENSE_METADATA_MAX_LENGTH,
        });
      })
      .filter(Boolean)
      .join(" OR ");
  }
  licenseDeclared = licenseDeclared
    ? assertSafeMetadataString(licenseDeclared, "license", {
      maxLength: LICENSE_METADATA_MAX_LENGTH,
    })
    : "NOASSERTION";

  let homepage = "NOASSERTION";
  if (Object.hasOwn(manifest, "homepage")) {
    homepage = assertSafeMetadataString(manifest.homepage, "homepage", {
      maxLength: HOMEPAGE_METADATA_MAX_LENGTH,
    });
  }

  let description = null;
  if (Object.hasOwn(manifest, "description")) {
    description = assertSafeMetadataString(manifest.description, "description", {
      allowEmpty: true,
      allowEdgeWhitespace: true,
    });
  }

  if (manifest.gypfile !== undefined && typeof manifest.gypfile !== "boolean") {
    fail("SUPPLY_CHAIN_TARBALL_MANIFEST", "package.json#gypfile 必须是 boolean。" );
  }
  if (Object.hasOwn(manifest, "hasInstallScript")) {
    fail("SUPPLY_CHAIN_TARBALL_MANIFEST", "package.json 不得自带 lock-only hasInstallScript 字段。" );
  }

  let scripts = {};
  if (manifest.scripts !== undefined) {
    if (!isPlainObject(manifest.scripts)) {
      fail("SUPPLY_CHAIN_TARBALL_SCRIPTS", "package.json#scripts 必须是 object。" );
    }
    const entries = Object.entries(manifest.scripts).sort(([left], [right]) => compareBytes(left, right));
    for (const [name, command] of entries) {
      if (
        name === ""
        || /[\u0000-\u001f\u007f]/u.test(name)
        || hasIsolatedSurrogate(name)
        || typeof command !== "string"
        || command.includes("\0")
        || hasIsolatedSurrogate(command)
      ) {
        fail("SUPPLY_CHAIN_TARBALL_SCRIPTS", `package.json#scripts[${JSON.stringify(name)}] 非法。`);
      }
    }
    scripts = Object.fromEntries(entries);
  }

  return {
    description,
    gypfile: manifest.gypfile ?? null,
    homepage,
    licenseDeclared,
    scripts,
  };
}

function validateLegalText(file) {
  const rawText = decodeUtf8(file.bytes, "SUPPLY_CHAIN_TARBALL_LEGAL", file.path);
  if (rawText.trim() === "" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(rawText)) {
    fail("SUPPLY_CHAIN_TARBALL_LEGAL", `${file.path} 不是受控非空文本。`);
  }
  return {
    path: file.path,
    rawSha256: createHash("sha256").update(file.bytes).digest("hex"),
    size: file.bytes.length,
    text: rawText.replace(/\r\n?/g, "\n"),
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort(compareBytes).map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function canonicalBytes(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function parseTarArchive(tar, expectedName, expectedVersion, licenseEvidenceRecord = null) {
  if (tar.length < END_BLOCKS_SIZE || tar.length % BLOCK_SIZE !== 0) {
    fail("SUPPLY_CHAIN_TARBALL_FORMAT", "解压后的 tar 长度不是完整 512-byte block 序列。" );
  }
  const occupiedCaseFoldedPaths = new Map();
  const pathTrie = { children: new Map(), type: null };
  const licenses = [];
  const notices = [];
  let supplementalSource = null;
  const supplementalTarballPath = licenseEvidenceRecord?.evidenceType
      === "tarball-reviewed-section"
    ? licenseEvidenceRecord.source.path
    : null;
  let packageJson = null;
  let bindingGyp = false;
  let pendingExtension = null;
  let pathIndexBytes = 0;
  let legalTotalBytes = 0;
  let entries = 0;
  let offset = 0;
  let activeRoot = null;
  const allowedRoots = new Set(["package"]);
  if (expectedName.startsWith("@types/")) {
    const legacyName = expectedName.slice("@types/".length);
    allowedRoots.add(legacyName);
    const versionParts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\./.exec(expectedVersion);
    if (versionParts !== null) {
      allowedRoots.add(`${legacyName} v${versionParts[1]}.${versionParts[2]}`);
    }
  }

  function reservePathIndex(bytes) {
    pathIndexBytes += bytes;
    if (pathIndexBytes > TARBALL_LIMITS.pathIndexBytes) {
      fail("SUPPLY_CHAIN_TARBALL_LIMIT", "tar 路径索引超过审查上限。" );
    }
  }

  function indexPath(path, type) {
    const segments = path.split("/");
    let node = pathTrie;
    let ancestor = "";
    for (const segment of segments) {
      if (node.type === "file") {
        fail("SUPPLY_CHAIN_TARBALL_STRUCTURE", `${ancestor} 同时是 regular file 与父目录。`);
      }
      let child = node.children.get(segment);
      if (child === undefined) {
        reservePathIndex(Buffer.byteLength(segment, "utf8") + PATH_INDEX_ENTRY_OVERHEAD);
        child = { children: new Map(), type: null };
        node.children.set(segment, child);
      }
      node = child;
      ancestor = ancestor === "" ? segment : `${ancestor}/${segment}`;
    }
    if (node.type !== null) {
      fail("SUPPLY_CHAIN_TARBALL_DUPLICATE_PATH", `tar 最终路径 ${path} 重复。`);
    }
    if (type === "file" && node.children.size > 0) {
      fail("SUPPLY_CHAIN_TARBALL_STRUCTURE", `${path} 同时是 regular file 与父目录。`);
    }
    node.type = type;

    const caseFolded = path.toLowerCase();
    const conflictingPath = occupiedCaseFoldedPaths.get(caseFolded);
    if (conflictingPath !== undefined && conflictingPath !== path) {
      fail(
        "SUPPLY_CHAIN_TARBALL_CASE_CONFLICT",
        `tar 路径 ${path} 与 ${conflictingPath} 存在大小写冲突。`,
      );
    }
    if (conflictingPath === undefined) {
      reservePathIndex(
        Buffer.byteLength(caseFolded, "utf8")
        + Buffer.byteLength(path, "utf8")
        + PATH_INDEX_ENTRY_OVERHEAD,
      );
      occupiedCaseFoldedPaths.set(caseFolded, path);
    }
  }

  function collectLegal(path, bytes, collection) {
    if (bytes.length === 0 || bytes.length > TARBALL_LIMITS.legalFileBytes) {
      fail("SUPPLY_CHAIN_TARBALL_LIMIT", `${path} 为空或超过 legal 文件上限。`);
    }
    if (licenses.length + notices.length >= TARBALL_LIMITS.legalFiles) {
      fail("SUPPLY_CHAIN_TARBALL_LIMIT", "license/NOTICE 文件数超过审查上限。" );
    }
    legalTotalBytes += bytes.length;
    if (legalTotalBytes > TARBALL_LIMITS.legalTotalBytes) {
      fail("SUPPLY_CHAIN_TARBALL_LIMIT", "license/NOTICE 总字节数超过审查上限。" );
    }
    collection.push({ bytes: Buffer.from(bytes), path });
  }

  while (offset < tar.length) {
    const block = tar.subarray(offset, offset + BLOCK_SIZE);
    if (isAllZero(block)) {
      if (pendingExtension !== null) {
        fail("SUPPLY_CHAIN_TARBALL_FORMAT", "tar 在扩展 header 后提前结束。" );
      }
      if (offset + END_BLOCKS_SIZE > tar.length || !isAllZero(tar.subarray(offset + BLOCK_SIZE, offset + END_BLOCKS_SIZE))) {
        fail("SUPPLY_CHAIN_TARBALL_FORMAT", "tar 结尾缺少连续两个全零 block。" );
      }
      if (!isAllZero(tar.subarray(offset + END_BLOCKS_SIZE))) {
        fail("SUPPLY_CHAIN_TARBALL_FORMAT", "tar 结束标记后包含非零数据。" );
      }
      if (packageJson === null) {
        fail("SUPPLY_CHAIN_TARBALL_MANIFEST", "tarball 缺少 package/package.json。" );
      }
      return {
        bindingGyp,
        entries,
        licenses,
        notices,
        packageJson,
        supplementalSource,
      };
    }

    entries += 1;
    if (entries > TARBALL_LIMITS.entries) {
      fail("SUPPLY_CHAIN_TARBALL_LIMIT", "tar entry 数超过审查上限。" );
    }
    const header = parseHeader(block);
    const entrySize = (
      header.type !== "x"
      && header.type !== "L"
      && pendingExtension?.kind === "pax"
      && pendingExtension.values.size !== undefined
    )
      ? pendingExtension.values.size
      : header.size;
    const bodyStart = offset + BLOCK_SIZE;
    const paddedSize = Math.ceil(entrySize / BLOCK_SIZE) * BLOCK_SIZE;
    const bodyEnd = bodyStart + entrySize;
    const nextOffset = bodyStart + paddedSize;
    if (bodyEnd > tar.length || nextOffset > tar.length) {
      fail("SUPPLY_CHAIN_TARBALL_FORMAT", "tar entry body 或 padding 被截断。" );
    }
    if (!isAllZero(tar.subarray(bodyEnd, nextOffset))) {
      fail("SUPPLY_CHAIN_TARBALL_FORMAT", "tar entry padding 包含非零数据。" );
    }
    const body = tar.subarray(bodyStart, bodyEnd);
    offset = nextOffset;

    if (header.type === "g") {
      fail("SUPPLY_CHAIN_TARBALL_TYPE", "global PAX header 不在受控 npm tar 子集中。" );
    }
    if (header.type === "x" || header.type === "L") {
      if (pendingExtension !== null) {
        fail("SUPPLY_CHAIN_TARBALL_EXTENSION", "tar 不允许堆叠 PAX/GNU path override。" );
      }
      if (header.linkname !== "") {
        fail("SUPPLY_CHAIN_TARBALL_HEADER", "扩展 header 的 linkname 必须为空。" );
      }
      if (header.type === "x") {
        assertExtensionHeaderPath(header.path, "PAX");
        pendingExtension = { kind: "pax", values: parsePaxPayload(body) };
      } else {
        assertExtensionHeaderPath(header.path, "GNU longname");
        pendingExtension = { kind: "longname", path: parseLongnamePayload(body) };
      }
      continue;
    }

    if (!["\0", "0", "5"].includes(header.type)) {
      fail("SUPPLY_CHAIN_TARBALL_TYPE", `tar typeflag ${JSON.stringify(header.type)} 不在受控 npm tar 子集中。`);
    }
    if (header.linkname !== "") {
      fail("SUPPLY_CHAIN_TARBALL_HEADER", "regular/directory entry 的 linkname 必须为空。" );
    }
    if (header.type === "5" && entrySize !== 0) {
      fail("SUPPLY_CHAIN_TARBALL_HEADER", "directory entry size 必须为 0。" );
    }

    let finalPath = header.path;
    if (pendingExtension?.kind === "pax") {
      finalPath = pendingExtension.values.path ?? finalPath;
    } else if (pendingExtension?.kind === "longname") {
      finalPath = pendingExtension.path;
    }
    pendingExtension = null;

    const type = header.type === "5" ? "directory" : "file";
    const validatedPath = validateFinalPath(finalPath, type, allowedRoots, activeRoot);
    activeRoot ??= validatedPath.archiveRoot;
    const canonicalPath = validatedPath.canonical;
    indexPath(canonicalPath, type);
    const packageRelativePath = canonicalPath.startsWith("package/")
      ? canonicalPath.slice("package/".length)
      : "";
    const relativeSegments = packageRelativePath === "" ? [] : packageRelativePath.split("/");
    const basename = relativeSegments.at(-1) ?? "";
    const licenseDirectory = relativeSegments.slice(0, -1).some((segment) => (
      /^(?:licenses?|licences?|copying)$/i.test(segment)
    ));
    const isPackageJson = canonicalPath === "package/package.json";
    const isBindingGyp = canonicalPath === "package/binding.gyp";
    const isLicense = type === "file" && (
      matchesLegalBasename(basename, LICENSE_BASENAMES)
      || licenseDirectory
    );
    const isNotice = type === "file" && matchesLegalBasename(basename, NOTICE_BASENAMES);
    if (type !== "file" && (isPackageJson || isBindingGyp || isLicense || isNotice)) {
      fail("SUPPLY_CHAIN_TARBALL_TYPE", `${canonicalPath} 必须是 ordinary regular file。`);
    }
    if (type !== "file") continue;
    if (canonicalPath === supplementalTarballPath) {
      if (body.length === 0 || body.length > TARBALL_LIMITS.legalFileBytes) {
        fail(
          "SUPPLY_CHAIN_LICENSE_EVIDENCE_LIMIT",
          `${canonicalPath} 为空或超过补充法律证据源文件上限。`,
        );
      }
      supplementalSource = Buffer.from(body);
    }
    if (isPackageJson) {
      if (body.length === 0 || body.length > TARBALL_LIMITS.packageJsonBytes) {
        fail("SUPPLY_CHAIN_TARBALL_LIMIT", "package/package.json 为空或超过审查上限。" );
      }
      packageJson = Buffer.from(body);
    } else if (isBindingGyp) {
      bindingGyp = true;
    }
    if (isLicense) collectLegal(canonicalPath, body, licenses);
    if (isNotice) collectLegal(canonicalPath, body, notices);
  }
  fail("SUPPLY_CHAIN_TARBALL_FORMAT", "tar 缺少两个全零结束 block。" );
}

function parseIntegrity(integrity) {
  const match = SHA512_INTEGRITY.exec(integrity ?? "");
  if (!match) {
    fail("SUPPLY_CHAIN_TARBALL_INTEGRITY", "lock integrity 必须是单一 canonical SHA-512 SRI。" );
  }
  const digest = Buffer.from(match[1], "base64");
  if (digest.length !== 64 || digest.toString("base64") !== match[1]) {
    fail("SUPPLY_CHAIN_TARBALL_INTEGRITY", "lock SHA-512 SRI 编码无效。" );
  }
  return digest;
}

function validateLockedPackage(lockedPackage) {
  if (
    !isPlainObject(lockedPackage)
    || typeof lockedPackage.name !== "string"
    || lockedPackage.name === ""
    || typeof lockedPackage.version !== "string"
    || lockedPackage.version === ""
    || typeof lockedPackage.hasInstallScript !== "boolean"
  ) {
    fail("SUPPLY_CHAIN_TARBALL_INPUT", "lockedPackage 缺少精确 name/version/hasInstallScript。" );
  }
  const identity = exactPackageIdentity(lockedPackage.name, lockedPackage.version);
  if (lockedPackage.identity !== undefined && lockedPackage.identity !== identity) {
    fail("SUPPLY_CHAIN_TARBALL_INPUT", "lockedPackage.identity 与 name/version 不一致。" );
  }
  return {
    expectedDigest: parseIntegrity(lockedPackage.integrity),
    hasInstallScript: lockedPackage.hasInstallScript,
    integrity: lockedPackage.integrity,
    name: lockedPackage.name,
    version: lockedPackage.version,
    identity,
  };
}

function materializeSupplementalLicense(record, archive) {
  if (record.evidenceType === "owner-exception") return [];
  if (record.evidenceType === "upstream-immutable") {
    const repository = new URL(record.source.repository);
    const path = [
      "supplement",
      "upstream",
      ...repository.pathname.slice(1).split("/"),
      record.source.revision,
      record.source.path,
    ].join("/");
    const bytes = Buffer.from(record.source.text, "utf8");
    try {
      const file = validateLegalText({ bytes, path });
      if (file.rawSha256 !== record.source.rawSha256) {
        fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_HASH", "upstream 补充法律正文摘要发生漂移。");
      }
      return [file];
    } finally {
      bytes.fill(0);
    }
  }
  if (record.evidenceType !== "tarball-reviewed-section") {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SCHEMA", "补充法律证据类型不受支持。");
  }
  const source = archive.supplementalSource;
  if (!Buffer.isBuffer(source)) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SOURCE", "精确 tarball 缺少获准的法律证据源文件。");
  }
  try {
    if (createHash("sha256").update(source).digest("hex") !== record.source.fileRawSha256) {
      fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_HASH", "tarball 补充法律证据源文件摘要发生漂移。");
    }
    if (record.source.endByte > source.length) {
      fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_SOURCE", "tarball 补充法律证据字节区间越界。");
    }
    const section = source.subarray(record.source.startByte, record.source.endByte);
    const expected = Buffer.from(record.source.text, "utf8");
    try {
      if (
        !section.equals(expected)
        || createHash("sha256").update(section).digest("hex")
          !== record.source.sectionRawSha256
      ) {
        fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_HASH", "tarball 补充法律证据区段发生漂移。");
      }
      const path = `supplement/tarball/${record.source.path.slice("package/".length)}#bytes-${record.source.startByte}-${record.source.endByte}`;
      return [validateLegalText({ bytes: section, path })];
    } finally {
      expected.fill(0);
    }
  } finally {
    source.fill(0);
  }
}

export function inspectPackageTarball(tarball, lockedPackage, licenseEvidenceRecord = null) {
  if (!Buffer.isBuffer(tarball) || tarball.length === 0) {
    fail("SUPPLY_CHAIN_TARBALL_INPUT", "tarball 必须是非空 Buffer。" );
  }
  if (tarball.length > TARBALL_LIMITS.compressedBytes) {
    fail("SUPPLY_CHAIN_TARBALL_LIMIT", "压缩 tarball 超过审查上限。" );
  }
  const expected = validateLockedPackage(lockedPackage);
  const actualDigest = createHash("sha512").update(tarball).digest();
  if (!actualDigest.equals(expected.expectedDigest)) {
    fail("SUPPLY_CHAIN_TARBALL_INTEGRITY", "tarball SHA-512 与 lock integrity 不一致。" );
  }
  if (tarball[0] !== 0x1f || tarball[1] !== 0x8b) {
    fail("SUPPLY_CHAIN_TARBALL_GZIP", "tarball 不是 gzip 数据。" );
  }

  let tar;
  try {
    tar = gunzipSync(tarball, { maxOutputLength: TARBALL_LIMITS.decompressedBytes });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") {
      fail("SUPPLY_CHAIN_TARBALL_LIMIT", "gzip 解压结果超过审查上限。" );
    }
    fail("SUPPLY_CHAIN_TARBALL_GZIP", "tarball gzip 校验或解压失败。" );
  }
  if (tar.length > TARBALL_LIMITS.decompressedBytes) {
    fail("SUPPLY_CHAIN_TARBALL_LIMIT", "解压后的 tar 超过审查上限。" );
  }

  const archive = parseTarArchive(
    tar,
    expected.name,
    expected.version,
    licenseEvidenceRecord,
  );
  const metadata = parsePackageJson(archive.packageJson, expected.name, expected.version);
  if (licenseEvidenceRecord !== null && archive.licenses.length !== 0) {
    fail(
      "SUPPLY_CHAIN_LICENSE_EVIDENCE_REDUNDANT",
      "补充法律证据只能绑定没有受控 tarball LICENSE 的精确发布。",
    );
  }
  if (
    licenseEvidenceRecord !== null
    && (
      licenseEvidenceRecord.integrity !== expected.integrity
      || licenseEvidenceRecord.licenseDeclared !== metadata.licenseDeclared
    )
  ) {
    fail("SUPPLY_CHAIN_LICENSE_EVIDENCE_DRIFT", "补充法律证据与 tarball 身份或声明不一致。");
  }
  if (archive.licenses.length === 0 && licenseEvidenceRecord === null) {
    fail("SUPPLY_CHAIN_TARBALL_LICENSE", "tarball 缺少受控 LICENSE/LICENCE/COPYING 证据。" );
  }
  const licenseFiles = (
    archive.licenses.length === 0
      ? materializeSupplementalLicense(licenseEvidenceRecord, archive)
      : archive.licenses.map(validateLegalText)
  ).sort((left, right) => compareBytes(left.path, right.path));
  const noticeFiles = archive.notices.map(validateLegalText).sort((left, right) => compareBytes(left.path, right.path));

  const effectiveInstallScripts = {};
  for (const event of INSTALL_EVENTS) {
    if (metadata.scripts[event]) {
      if (metadata.scripts[event].includes("\r") || PERSISTED_TEXT_CONTROL.test(metadata.scripts[event])) {
        fail(
          "SUPPLY_CHAIN_TARBALL_SCRIPTS",
          `package.json#scripts.${event} 包含不允许持久化的控制字符。`,
        );
      }
      effectiveInstallScripts[event] = metadata.scripts[event];
    }
  }
  let implicitNodeGyp = false;
  if (
    archive.bindingGyp
    && metadata.gypfile !== false
    && !metadata.scripts.preinstall
    && !metadata.scripts.install
  ) {
    effectiveInstallScripts.install = "node-gyp rebuild";
    implicitNodeGyp = true;
  }
  const actualHasInstallScript = Object.keys(effectiveInstallScripts).length > 0;
  if (actualHasInstallScript && !expected.hasInstallScript) {
    fail(
      "SUPPLY_CHAIN_TARBALL_SCRIPT_MISMATCH",
      "tarball 的实际 install scripts/binding.gyp 未被 lock hasInstallScript 标记。",
    );
  }

  const scriptsSha256 = createHash("sha256")
    .update(canonicalBytes(metadata.scripts), "utf8")
    .digest("hex");
  const packageJsonSha256 = createHash("sha256").update(archive.packageJson).digest("hex");
  return {
    actualHasInstallScript,
    description: metadata.description,
    effectiveInstallScripts,
    entryCount: archive.entries,
    bindingGyp: archive.bindingGyp,
    gypfile: metadata.gypfile,
    homepage: metadata.homepage,
    identity: expected.identity,
    implicitNodeGyp,
    integrity: expected.integrity,
    integritySha512: actualDigest.toString("hex"),
    licenseDeclared: metadata.licenseDeclared,
    licenseFiles,
    noticeFiles,
    packageJsonSha256,
    scripts: metadata.scripts,
    scriptsSha256,
  };
}

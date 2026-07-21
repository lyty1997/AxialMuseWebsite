import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "./spdx.mjs";
import {
  buildExpectedSpdxGraph,
  exactPackageIdentity,
} from "./lockfile.mjs";
import { OFFICIAL_REGISTRY } from "./contracts.mjs";
import { fail } from "./errors.mjs";

const MAGIC = "AxialMuseWebsite THIRD_PARTY_NOTICES v1";
const HEX_64 = /^[0-9a-f]{64}$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const SAFE_LINE = /^[^\u0000-\u001f\u007f]+$/;
const INSTALL_SCRIPT_NAMES = Object.freeze(["install", "postinstall", "preinstall"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_NOTICE_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_FILE_RECORDS = 64;
const MAX_PACKAGE_RECORDS = 50000;
const MAX_LEGAL_TEXT_BYTES = 16 * 1024 * 1024;
const PERSISTED_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const SELF_CLOSURE_ROOT = Object.freeze({
  name: "AxialMuseSelfClosureRoot",
  version: "0.0.0",
});

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertSafeLine(value, pointer, { maxLength = 4096 } = {}) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.length > maxLength
    || !SAFE_LINE.test(value)
    || hasUnpairedSurrogate(value)
  ) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${pointer} 必须是受控单行字符串。`);
  }
  return value;
}

function assertFramedText(value, pointer, {
  allowEmpty = true,
  allowNull = false,
  maxBytes = MAX_FRAME_BYTES,
} = {}) {
  if (value === null && allowNull) return null;
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || PERSISTED_TEXT_CONTROL.test(value)
    || value.includes("\r")
    || hasUnpairedSurrogate(value)
    || Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${pointer} 必须是受控 UTF-8 文本。`);
  }
  return value;
}

function validateHomepage(value, pointer) {
  if (value === "NOASSERTION") return value;
  return assertSafeLine(value, pointer);
}

function parseIdentity(identity) {
  assertSafeLine(identity, "$notice.identity", { maxLength: 512 });
  const separator = identity.lastIndexOf("@");
  if (separator <= 0) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity} 不是精确 name@version。`);
  }
  const name = identity.slice(0, separator);
  const version = identity.slice(separator + 1);
  if (exactPackageIdentity(name, version) !== identity) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity} 不是规范依赖身份。`);
  }
  return identity;
}

function validateFileRecords(value, pointer, { requireNonEmpty }) {
  if (
    !Array.isArray(value)
    || value.length > MAX_FILE_RECORDS
    || (requireNonEmpty && value.length === 0)
  ) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${pointer} 文件集合不合法。`);
  }
  const records = value.map((file, index) => {
    if (
      file === null
      || typeof file !== "object"
      || Array.isArray(file)
      || Object.keys(file).sort().join("\0") !== "path\0rawSha256\0text"
    ) {
      fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${pointer}[${index}] 字段集合不合法。`);
    }
    const path = assertSafeLine(file.path, `${pointer}[${index}].path`);
    if (
      (!path.startsWith("package/") && !path.startsWith("supplement/"))
      || path.includes("\\")
      || path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${pointer}[${index}].path 不是受控法律证据路径。`);
    }
    if (!HEX_64.test(file.rawSha256 ?? "")) {
      fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${pointer}[${index}].rawSha256 不是 lowercase SHA-256。`);
    }
    const text = assertFramedText(file.text, `${pointer}[${index}].text`, {
      allowEmpty: false,
    });
    return {
      path,
      rawSha256: file.rawSha256,
      text,
    };
  });
  const sorted = [...records].sort((left, right) => compareBytes(left.path, right.path));
  if (
    new Set(records.map((file) => file.path)).size !== records.length
    || records.some((file, index) => file.path !== sorted[index].path)
  ) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${pointer} 必须按路径字节排序且不重复。`);
  }
  return records;
}

function validateInstallScripts(value, pointer) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${pointer} 必须是 object。`);
  }
  const names = Object.keys(value).sort(compareBytes);
  if (names.some((name) => !INSTALL_SCRIPT_NAMES.includes(name))) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${pointer} 包含非安装生命周期脚本。`);
  }
  const result = {};
  for (const name of names) {
    result[name] = assertFramedText(value[name], `${pointer}.${name}`);
  }
  return result;
}

function validateObligations(value, pointer) {
  if (!Array.isArray(value) || value.length > 1000) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${pointer} 必须是 array。`);
  }
  const obligations = value.map((item, index) => assertSafeLine(
    item,
    `${pointer}[${index}]`,
    { maxLength: 1000 },
  ));
  const sorted = [...obligations].sort(compareBytes);
  if (
    new Set(obligations).size !== obligations.length
    || obligations.some((item, index) => item !== sorted[index])
  ) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${pointer} 必须按 UTF-8 字节排序且不重复。`);
  }
  return obligations;
}

export function validateNoticeRecord(record) {
  if (
    record === null
    || typeof record !== "object"
    || Array.isArray(record)
    || Object.keys(record).sort().join("\0") !== [
      "bindingGyp",
      "decisionId",
      "description",
      "gypfile",
      "homepage",
      "identity",
      "implicitNodeGyp",
      "installScripts",
      "integrity",
      "licenseClarification",
      "licenseDeclared",
      "licenseFiles",
      "noticeFiles",
      "obligations",
      "packageJsonSha256",
      "purpose",
      "resolved",
      "scriptDisposition",
    ].sort().join("\0")
  ) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", "THIRD_PARTY_NOTICES package record 字段集合不合法。");
  }
  const identity = parseIdentity(record.identity);
  let resolved;
  try {
    resolved = new URL(record.resolved);
  } catch {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity} resolved 不是合法 URL。`);
  }
  if (
    resolved.href !== record.resolved
    || resolved.origin !== OFFICIAL_REGISTRY.slice(0, -1)
    || resolved.protocol !== "https:"
    || resolved.username !== ""
    || resolved.password !== ""
    || resolved.search !== ""
    || resolved.hash !== ""
  ) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity} resolved 超出受控 URL 边界。`);
  }
  if (!SHA512_INTEGRITY.test(record.integrity ?? "")) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity} integrity 不是 SHA-512 SRI。`);
  }
  const integrityDigest = Buffer.from(record.integrity.slice("sha512-".length), "base64");
  if (
    integrityDigest.length !== 64
    || integrityDigest.toString("base64") !== record.integrity.slice("sha512-".length)
  ) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity} integrity 不是规范 SHA-512 SRI。`);
  }
  if (!HEX_64.test(record.packageJsonSha256 ?? "")) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity} packageJsonSha256 不合法。`);
  }
  if (typeof record.bindingGyp !== "boolean") {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity} bindingGyp 必须是 boolean。`);
  }
  if (record.gypfile !== null && typeof record.gypfile !== "boolean") {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity} gypfile 必须是 boolean 或 null。`);
  }
  if (typeof record.implicitNodeGyp !== "boolean") {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity} implicitNodeGyp 必须是 boolean。`);
  }
  if (!["absent", "ignored", "approved-exception"].includes(record.scriptDisposition)) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity} scriptDisposition 不受支持。`);
  }
  const installScripts = validateInstallScripts(record.installScripts, `${identity}.installScripts`);
  if (
    record.implicitNodeGyp
    && (
      !record.bindingGyp
      || record.gypfile === false
      || Object.hasOwn(installScripts, "preinstall")
      || installScripts.install !== "node-gyp rebuild"
    )
  ) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity} implicit node-gyp 证据不自洽。`);
  }
  if (
    !record.implicitNodeGyp
    && record.bindingGyp
    && record.gypfile !== false
    && !Object.hasOwn(installScripts, "preinstall")
    && !Object.hasOwn(installScripts, "install")
  ) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity} 缺少 binding.gyp 隐式 install 证据。`);
  }
  const licenseFiles = validateFileRecords(
    record.licenseFiles,
    `${identity}.licenseFiles`,
    { requireNonEmpty: false },
  );
  const noticeFiles = validateFileRecords(
    record.noticeFiles,
    `${identity}.noticeFiles`,
    { requireNonEmpty: false },
  );
  const legalFiles = [...licenseFiles, ...noticeFiles];
  if (
    legalFiles.length > MAX_FILE_RECORDS
    || legalFiles.reduce((total, file) => total + Buffer.byteLength(file.text, "utf8"), 0)
      > MAX_LEGAL_TEXT_BYTES
  ) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity} 法律文件集合超过受控总量。`);
  }
  return {
    identity,
    resolved: record.resolved,
    integrity: record.integrity,
    packageJsonSha256: record.packageJsonSha256,
    licenseDeclared: assertSafeLine(record.licenseDeclared, `${identity}.licenseDeclared`, { maxLength: 200 }),
    homepage: validateHomepage(record.homepage, `${identity}.homepage`),
    description: assertFramedText(record.description, `${identity}.description`, {
      allowEmpty: true,
      allowNull: true,
    }),
    bindingGyp: record.bindingGyp,
    gypfile: record.gypfile,
    implicitNodeGyp: record.implicitNodeGyp,
    installScripts,
    licenseFiles,
    noticeFiles,
    purpose: assertSafeLine(record.purpose, `${identity}.purpose`, { maxLength: 1000 }),
    licenseClarification: assertSafeLine(
      record.licenseClarification,
      `${identity}.licenseClarification`,
      { maxLength: 1000 },
    ),
    scriptDisposition: record.scriptDisposition,
    obligations: validateObligations(record.obligations, `${identity}.obligations`),
    decisionId: (() => {
      const decisionId = assertSafeLine(record.decisionId, `${identity}.decisionId`, { maxLength: 200 });
      if (!/^D-[0-9]{3}$/.test(decisionId)) {
        fail("SUPPLY_CHAIN_NOTICE_SCHEMA", `${identity}.decisionId 必须是 D-xxx。`);
      }
      return decisionId;
    })(),
  };
}

export function packageEvidenceObject(recordInput) {
  const record = validateNoticeRecord(recordInput);
  return {
    identity: record.identity,
    install: {
      bindingGyp: record.bindingGyp,
      gypfile: record.gypfile,
      implicitNodeGyp: record.implicitNodeGyp,
      scripts: record.installScripts,
    },
    kind: "axial_muse_package_evidence",
    legal: {
      licenseDeclared: record.licenseDeclared,
      licenseFiles: record.licenseFiles,
      noticeFiles: record.noticeFiles,
    },
    manifest: {
      description: record.description,
      homepage: record.homepage,
      packageJsonSha256: record.packageJsonSha256,
    },
    source: {
      integrity: record.integrity,
      resolved: record.resolved,
    },
    version: "0.1.0",
  };
}

export function packageEvidenceSha256(record) {
  return sha256(canonicalJsonBytes(packageEvidenceObject(record)));
}

export function packageEvidenceObjectFromTarballInspection({ inspection, lockedPackage }) {
  const evidenceOnlyRecord = createNoticeRecordFromTarballInspection({
    admission: {
      decisionId: "D-077",
      licenseClarification: "Evidence-only tarball projection.",
      obligations: [],
      purpose: "Evidence-only tarball projection.",
      scriptDisposition: Object.keys(inspection?.effectiveInstallScripts ?? {}).length > 0
        ? "ignored"
        : "absent",
    },
    inspection,
    lockedPackage,
  });
  return packageEvidenceObject(evidenceOnlyRecord);
}

export function packageEvidenceSha256FromTarballInspection(input) {
  return sha256(canonicalJsonBytes(packageEvidenceObjectFromTarballInspection(input)));
}

function frame(label, value) {
  return `${label}-Bytes: ${Buffer.byteLength(value, "utf8")}\n${value}\n`;
}

function renderFileRecords(label, files, append) {
  append(`${label}-Files: ${files.length}\n`);
  for (const file of files) {
    append(`${label}-File: ${file.path}\n`);
    append(`${label}-Raw-SHA256: ${file.rawSha256}\n`);
    append(frame(`${label}-Text`, file.text));
  }
}

export function renderThirdPartyNotices(recordsInput) {
  if (!Array.isArray(recordsInput) || recordsInput.length > MAX_PACKAGE_RECORDS) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", "THIRD_PARTY_NOTICES records 必须是 array。");
  }
  const records = recordsInput.map(validateNoticeRecord).sort((left, right) => compareBytes(
    left.identity,
    right.identity,
  ));
  if (new Set(records.map((record) => record.identity)).size !== records.length) {
    fail("SUPPLY_CHAIN_NOTICE_SCHEMA", "THIRD_PARTY_NOTICES 包身份重复。");
  }
  const chunks = [];
  let outputBytes = 0;
  const append = (value) => {
    outputBytes += Buffer.byteLength(value, "utf8");
    if (outputBytes > MAX_NOTICE_BYTES) {
      fail("SUPPLY_CHAIN_NOTICE_SCHEMA", "THIRD_PARTY_NOTICES 大小超出受控范围。" );
    }
    chunks.push(value);
  };
  append(`${MAGIC}\n`);
  for (const record of records) {
    append(`Package: ${record.identity}\n`);
    append(`Source: ${record.resolved}\n`);
    append(`Integrity: ${record.integrity}\n`);
    append(`Package-Json-SHA256: ${record.packageJsonSha256}\n`);
    append(`License: ${record.licenseDeclared}\n`);
    append(`Homepage: ${record.homepage}\n`);
    append(`Description-Present: ${record.description === null ? "false" : "true"}\n`);
    if (record.description !== null) append(frame("Description", record.description));
    append(`Binding-Gyp: ${record.bindingGyp ? "true" : "false"}\n`);
    append(`Gypfile: ${record.gypfile === null ? "null" : String(record.gypfile)}\n`);
    append(`Implicit-Node-Gyp: ${record.implicitNodeGyp ? "true" : "false"}\n`);
    const scriptEntries = Object.entries(record.installScripts);
    append(`Install-Scripts: ${scriptEntries.length}\n`);
    for (const [name, command] of scriptEntries) {
      append(`Install-Script: ${name}\n`);
      append(frame("Install-Command", command));
    }
    renderFileRecords("License", record.licenseFiles, append);
    renderFileRecords("Notice", record.noticeFiles, append);
    append(frame("Purpose", record.purpose));
    append(frame("License-Clarification", record.licenseClarification));
    append(`Script-Disposition: ${record.scriptDisposition}\n`);
    append(`Obligations: ${record.obligations.length}\n`);
    for (const obligation of record.obligations) append(frame("Obligation", obligation));
    append(`Decision: ${record.decisionId}\n`);
    append("End-Package\n");
  }
  return chunks.join("");
}

function createReader(bytesInput) {
  const bytes = Buffer.isBuffer(bytesInput) ? bytesInput : Buffer.from(bytesInput);
  if (bytes.length === 0 || bytes.length > MAX_NOTICE_BYTES) {
    fail("SUPPLY_CHAIN_NOTICE_PARSE", "THIRD_PARTY_NOTICES 大小超出受控范围。" );
  }
  let cursor = 0;
  function readLine(expectedLabel = null) {
    const end = bytes.indexOf(0x0a, cursor);
    if (end === -1) fail("SUPPLY_CHAIN_NOTICE_PARSE", "THIRD_PARTY_NOTICES 行未终止。");
    const lineBytes = bytes.subarray(cursor, end);
    cursor = end + 1;
    if (lineBytes.includes(0x0d)) fail("SUPPLY_CHAIN_NOTICE_PARSE", "THIRD_PARTY_NOTICES 只允许 LF。" );
    let line;
    try {
      line = UTF8_DECODER.decode(lineBytes);
    } catch {
      fail("SUPPLY_CHAIN_NOTICE_PARSE", "THIRD_PARTY_NOTICES 不是合法 UTF-8。" );
    }
    if (expectedLabel !== null) {
      const prefix = `${expectedLabel}: `;
      if (!line.startsWith(prefix)) {
        fail("SUPPLY_CHAIN_NOTICE_PARSE", `THIRD_PARTY_NOTICES 缺少 ${expectedLabel}。`);
      }
      return line.slice(prefix.length);
    }
    return line;
  }
  function readCount(label, { max = MAX_PACKAGE_RECORDS } = {}) {
    const value = readLine(label);
    if (!/^(?:0|[1-9]\d*)$/.test(value)) {
      fail("SUPPLY_CHAIN_NOTICE_PARSE", `${label} 不是规范非负十进制。`);
    }
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count > max) {
      fail("SUPPLY_CHAIN_NOTICE_PARSE", `${label} 超出受控范围。`);
    }
    return count;
  }
  function readFrame(label) {
    const length = readCount(`${label}-Bytes`, { max: MAX_FRAME_BYTES });
    if (cursor + length >= bytes.length) {
      fail("SUPPLY_CHAIN_NOTICE_PARSE", `${label} 字节帧被截断。`);
    }
    const content = bytes.subarray(cursor, cursor + length);
    cursor += length;
    if (bytes[cursor] !== 0x0a) {
      fail("SUPPLY_CHAIN_NOTICE_PARSE", `${label} 字节帧缺少 framing LF。`);
    }
    cursor += 1;
    let value;
    try {
      value = UTF8_DECODER.decode(content);
    } catch {
      fail("SUPPLY_CHAIN_NOTICE_PARSE", `${label} 字节帧不是合法 UTF-8。`);
    }
    return assertFramedText(value, `$notice.${label}`);
  }
  return {
    atEnd: () => cursor === bytes.length,
    readCount,
    readFrame,
    readLine,
  };
}

function parseFileRecords(reader, label) {
  const count = reader.readCount(`${label}-Files`, { max: MAX_FILE_RECORDS });
  const files = [];
  for (let index = 0; index < count; index += 1) {
    files.push({
      path: reader.readLine(`${label}-File`),
      rawSha256: reader.readLine(`${label}-Raw-SHA256`),
      text: reader.readFrame(`${label}-Text`),
    });
  }
  return files;
}

export function parseThirdPartyNotices(bytesInput) {
  const reader = createReader(bytesInput);
  if (reader.readLine() !== MAGIC) {
    fail("SUPPLY_CHAIN_NOTICE_PARSE", "THIRD_PARTY_NOTICES magic/version 不受支持。" );
  }
  const records = [];
  while (!reader.atEnd()) {
    if (records.length >= MAX_PACKAGE_RECORDS) {
      fail("SUPPLY_CHAIN_NOTICE_PARSE", "THIRD_PARTY_NOTICES package 数量超出受控范围。" );
    }
    const record = {
      identity: reader.readLine("Package"),
      resolved: reader.readLine("Source"),
      integrity: reader.readLine("Integrity"),
      packageJsonSha256: reader.readLine("Package-Json-SHA256"),
      licenseDeclared: reader.readLine("License"),
      homepage: reader.readLine("Homepage"),
    };
    const descriptionPresent = reader.readLine("Description-Present");
    if (!new Set(["true", "false"]).has(descriptionPresent)) {
      fail("SUPPLY_CHAIN_NOTICE_PARSE", "Description-Present 必须是 boolean 文本。" );
    }
    record.description = descriptionPresent === "true" ? reader.readFrame("Description") : null;
    const bindingGyp = reader.readLine("Binding-Gyp");
    if (!new Set(["true", "false"]).has(bindingGyp)) {
      fail("SUPPLY_CHAIN_NOTICE_PARSE", "Binding-Gyp 必须是 boolean 文本。" );
    }
    record.bindingGyp = bindingGyp === "true";
    const gypfile = reader.readLine("Gypfile");
    if (!new Set(["null", "true", "false"]).has(gypfile)) {
      fail("SUPPLY_CHAIN_NOTICE_PARSE", "Gypfile 必须是 boolean 或 null 文本。" );
    }
    record.gypfile = gypfile === "null" ? null : gypfile === "true";
    const implicitNodeGyp = reader.readLine("Implicit-Node-Gyp");
    if (!new Set(["true", "false"]).has(implicitNodeGyp)) {
      fail("SUPPLY_CHAIN_NOTICE_PARSE", "Implicit-Node-Gyp 必须是 boolean 文本。" );
    }
    record.implicitNodeGyp = implicitNodeGyp === "true";
    const scriptCount = reader.readCount("Install-Scripts", { max: INSTALL_SCRIPT_NAMES.length });
    record.installScripts = {};
    for (let index = 0; index < scriptCount; index += 1) {
      const name = reader.readLine("Install-Script");
      if (Object.hasOwn(record.installScripts, name)) {
        fail("SUPPLY_CHAIN_NOTICE_PARSE", "Install-Script 重复。" );
      }
      record.installScripts[name] = reader.readFrame("Install-Command");
    }
    record.licenseFiles = parseFileRecords(reader, "License");
    record.noticeFiles = parseFileRecords(reader, "Notice");
    record.purpose = reader.readFrame("Purpose");
    record.licenseClarification = reader.readFrame("License-Clarification");
    record.scriptDisposition = reader.readLine("Script-Disposition");
    const obligationCount = reader.readCount("Obligations", { max: 1000 });
    record.obligations = [];
    for (let index = 0; index < obligationCount; index += 1) {
      record.obligations.push(reader.readFrame("Obligation"));
    }
    record.decisionId = reader.readLine("Decision");
    if (reader.readLine() !== "End-Package") {
      fail("SUPPLY_CHAIN_NOTICE_PARSE", "THIRD_PARTY_NOTICES package 未正确结束。" );
    }
    records.push(validateNoticeRecord(record));
  }
  const canonical = renderThirdPartyNotices(records);
  const original = Buffer.isBuffer(bytesInput) ? bytesInput : Buffer.from(bytesInput);
  if (!Buffer.from(canonical, "utf8").equals(original)) {
    fail("SUPPLY_CHAIN_NOTICE_CANONICAL", "THIRD_PARTY_NOTICES 不是 canonical 字节。" );
  }
  return records;
}

function assertIdentitySet(actual, expected) {
  const left = [...actual].sort(compareBytes);
  const right = [...expected].sort(compareBytes);
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    fail("SUPPLY_CHAIN_NOTICE_CLOSURE", "THIRD_PARTY_NOTICES 包集合与 lock/admissions 不一致。" );
  }
}

function projectSelfClosureSpdxPackage({
  integrity,
  packageFileName,
  resolved,
  versionInfo,
}) {
  const graph = buildExpectedSpdxGraph({
    lockfileVersion: 3,
    ...SELF_CLOSURE_ROOT,
    packages: {
      "": SELF_CLOSURE_ROOT,
      [packageFileName]: {
        integrity,
        resolved,
        version: versionInfo,
      },
    },
  }, SELF_CLOSURE_ROOT);
  return graph.packages.find((package_) => package_.packageFileName !== "");
}

function validateSelfClosureIdentityProjection(package_, record) {
  let expected;
  try {
    expected = projectSelfClosureSpdxPackage({
      integrity: record.integrity,
      packageFileName: package_.packageFileName,
      resolved: record.resolved,
      versionInfo: package_.versionInfo,
    });
  } catch {
    try {
      projectSelfClosureSpdxPackage({
        integrity: record.integrity,
        packageFileName: `node_modules/${package_.name}`,
        resolved: record.resolved,
        versionInfo: package_.versionInfo,
      });
    } catch {
      fail(
        "SUPPLY_CHAIN_NOTICE_SOURCE",
        `${record.identity} 的 NOTICE 来源无法从精确包身份派生。`,
      );
    }
    fail(
      "SUPPLY_CHAIN_NOTICE_CLOSURE",
      `${record.identity} 的 SPDX packageFileName 无法投影为精确包身份。`,
    );
  }

  if (
    expected === undefined
    || package_.SPDXID !== expected.SPDXID
    || package_.name !== expected.name
    || package_.versionInfo !== expected.versionInfo
    || package_.packageFileName !== expected.packageFileName
  ) {
    fail(
      "SUPPLY_CHAIN_NOTICE_CLOSURE",
      `${record.identity} 的 SPDX identity/path 投影不一致。`,
    );
  }
  if (
    !Array.isArray(package_.externalRefs)
    || package_.externalRefs.length !== 1
    || package_.externalRefs[0]?.referenceCategory !== "PACKAGE-MANAGER"
    || package_.externalRefs[0]?.referenceType !== "purl"
    || package_.externalRefs[0]?.referenceLocator !== expected.purl
  ) {
    fail(
      "SUPPLY_CHAIN_NOTICE_CLOSURE",
      `${record.identity} 的 SPDX purl 无法从精确包身份派生。`,
    );
  }
}

export function validateSpdxNoticesSelfClosure({ bytes, document }) {
  const records = parseThirdPartyNotices(bytes);
  if (
    document === null
    || typeof document !== "object"
    || Array.isArray(document)
    || !Array.isArray(document.packages)
  ) {
    fail("SUPPLY_CHAIN_NOTICE_CLOSURE", "SPDX document 缺少可校验的 package 集合。");
  }

  const spdxByIdentity = new Map();
  for (const package_ of document.packages) {
    if (
      package_ === null
      || typeof package_ !== "object"
      || Array.isArray(package_)
      || typeof package_.packageFileName !== "string"
    ) {
      fail("SUPPLY_CHAIN_NOTICE_CLOSURE", "SPDX package 无法投影为 NOTICE 依赖身份。");
    }
    if (package_.packageFileName === "") continue;

    let identity;
    try {
      identity = exactPackageIdentity(package_.name, package_.versionInfo);
    } catch {
      fail("SUPPLY_CHAIN_NOTICE_CLOSURE", "SPDX package 无法投影为 NOTICE 依赖身份。");
    }
    if (spdxByIdentity.has(identity)) {
      fail("SUPPLY_CHAIN_NOTICE_CLOSURE", `SPDX package 身份 ${identity} 重复。`);
    }
    spdxByIdentity.set(identity, package_);
  }

  const recordsByIdentity = new Map(records.map((record) => [record.identity, record]));
  const noticeIdentities = [...recordsByIdentity.keys()].sort(compareBytes);
  const spdxIdentities = [...spdxByIdentity.keys()].sort(compareBytes);
  if (
    noticeIdentities.length !== spdxIdentities.length
    || noticeIdentities.some((identity, index) => identity !== spdxIdentities[index])
  ) {
    fail("SUPPLY_CHAIN_NOTICE_CLOSURE", "THIRD_PARTY_NOTICES 包集合与既有 SPDX 不一致。");
  }

  for (const [identity, record] of recordsByIdentity) {
    const spdxPackage = spdxByIdentity.get(identity);
    validateSelfClosureIdentityProjection(spdxPackage, record);
    if (record.resolved !== spdxPackage.downloadLocation) {
      fail("SUPPLY_CHAIN_NOTICE_SOURCE", `${identity} 的 NOTICE 来源与既有 SPDX 不一致。`);
    }

    const expectedChecksum = Buffer.from(
      record.integrity.slice("sha512-".length),
      "base64",
    ).toString("hex");
    if (
      !Array.isArray(spdxPackage.checksums)
      || spdxPackage.checksums.length !== 1
      || spdxPackage.checksums[0]?.algorithm !== "SHA512"
      || spdxPackage.checksums[0]?.checksumValue !== expectedChecksum
    ) {
      fail("SUPPLY_CHAIN_NOTICE_CHECKSUM", `${identity} 的 NOTICE SRI 与既有 SPDX SHA512 不一致。`);
    }
    if (record.licenseDeclared !== spdxPackage.licenseDeclared) {
      fail("SUPPLY_CHAIN_NOTICE_LICENSE", `${identity} 的 NOTICE 许可证与既有 SPDX 不一致。`);
    }
  }
  return records;
}

export function validateNoticesClosure({ bytes, lockedPackages, document, admissions }) {
  const records = parseThirdPartyNotices(bytes);
  const recordsByIdentity = new Map(records.map((record) => [record.identity, record]));
  assertIdentitySet(
    recordsByIdentity.keys(),
    lockedPackages.map((package_) => package_.identity),
  );
  assertIdentitySet(recordsByIdentity.keys(), Object.keys(admissions.packages));
  const spdxByIdentity = new Map(document.packages
    .filter((package_) => package_.packageFileName !== "")
    .map((package_) => [exactPackageIdentity(package_.name, package_.versionInfo), package_]));
  assertIdentitySet(recordsByIdentity.keys(), spdxByIdentity.keys());

  for (const package_ of lockedPackages) {
    const record = recordsByIdentity.get(package_.identity);
    const admission = admissions.packages[package_.identity];
    const spdxPackage = spdxByIdentity.get(package_.identity);
    if (record.resolved !== package_.resolved || record.integrity !== package_.integrity) {
      fail("SUPPLY_CHAIN_NOTICE_SOURCE", `${package_.identity} 的 NOTICE 来源与 lock 不一致。`);
    }
    if (record.licenseDeclared !== spdxPackage.licenseDeclared) {
      fail("SUPPLY_CHAIN_NOTICE_LICENSE", `${package_.identity} 的 NOTICE 许可证与 SPDX 不一致。`);
    }
    for (const key of [
      "purpose",
      "licenseClarification",
      "scriptDisposition",
      "decisionId",
    ]) {
      if (record[key] !== admission[key]) {
        fail("SUPPLY_CHAIN_NOTICE_ADMISSION", `${package_.identity} 的 NOTICE 与 admission.${key} 不一致。`);
      }
    }
    if (canonicalJsonBytes(record.obligations) !== canonicalJsonBytes(admission.obligations)) {
      fail("SUPPLY_CHAIN_NOTICE_ADMISSION", `${package_.identity} 的 NOTICE obligations 与 admission 不一致。`);
    }
    if (packageEvidenceSha256(record) !== admission.evidenceSha256) {
      fail("SUPPLY_CHAIN_NOTICE_EVIDENCE", `${package_.identity} 的 NOTICE evidence 摘要与 admission 不一致。`);
    }
    const effectiveScript = Object.values(record.installScripts).some((command) => command.length > 0);
    if (effectiveScript && !package_.hasInstallScript) {
      fail("SUPPLY_CHAIN_NOTICE_SCRIPT", `${package_.identity} 的 NOTICE 脚本证据未被 lock 标记。`);
    }
  }
  return records;
}

export function createNoticeRecordFromTarballInspection({
  admission,
  inspection,
  lockedPackage,
}) {
  if (
    inspection === null
    || typeof inspection !== "object"
    || lockedPackage === null
    || typeof lockedPackage !== "object"
    || admission === null
    || typeof admission !== "object"
  ) {
    fail("SUPPLY_CHAIN_NOTICE_INPUT", "NOTICE 投影输入必须是 object。" );
  }
  if (
    inspection.identity !== lockedPackage.identity
    || inspection.integrity !== lockedPackage.integrity
  ) {
    fail("SUPPLY_CHAIN_NOTICE_INPUT", "tarball inspection 与 locked package 不一致。" );
  }
  return validateNoticeRecord({
    bindingGyp: inspection.bindingGyp,
    decisionId: admission.decisionId,
    description: inspection.description,
    gypfile: inspection.gypfile,
    homepage: inspection.homepage,
    identity: inspection.identity,
    implicitNodeGyp: inspection.implicitNodeGyp,
    installScripts: inspection.effectiveInstallScripts,
    integrity: inspection.integrity,
    licenseClarification: admission.licenseClarification,
    licenseDeclared: inspection.licenseDeclared,
    licenseFiles: inspection.licenseFiles.map(({ path, rawSha256, text }) => ({
      path,
      rawSha256,
      text,
    })),
    noticeFiles: inspection.noticeFiles.map(({ path, rawSha256, text }) => ({
      path,
      rawSha256,
      text,
    })),
    obligations: admission.obligations,
    packageJsonSha256: inspection.packageJsonSha256,
    purpose: admission.purpose,
    resolved: lockedPackage.resolved,
    scriptDisposition: admission.scriptDisposition,
  });
}

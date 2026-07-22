import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { NpmIsolationError } from "../../scripts/quality/lib/supply-chain/errors.mjs";
import {
  createNoticeRecordFromTarballInspection,
  packageEvidenceSha256,
  parseThirdPartyNotices,
  renderThirdPartyNotices,
  validateNoticesClosure,
  validateSpdxNoticesSelfClosure,
} from "../../scripts/quality/lib/supply-chain/notices.mjs";

const MAGIC = "AxialMuseWebsite THIRD_PARTY_NOTICES v1\n";

function clone(value) {
  return structuredClone(value);
}

function expectCode(action, code) {
  assert.throws(action, (error) => error instanceof NpmIsolationError && error.code === code);
}

function textSha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function legalFile(path, text) {
  return {
    path,
    rawSha256: textSha256(text),
    text,
  };
}

function identityParts(identity) {
  const separator = identity.lastIndexOf("@");
  return {
    name: identity.slice(0, separator),
    version: identity.slice(separator + 1),
  };
}

function recordFixture(overrides = {}) {
  const licenseText = "MIT 许可文本 ©\nPackage: forged@9.9.9\nEnd-Package\n--- not a delimiter ---";
  const noticeText = "NOTICE 文本\nLicense-Text-Bytes: 999\nEnd-Package";
  const record = {
    identity: "zeta@1.2.3",
    resolved: "https://registry.npmjs.org/zeta/-/zeta-1.2.3.tgz",
    integrity: `sha512-${Buffer.alloc(64, 0x11).toString("base64")}`,
    packageJsonSha256: "1".repeat(64),
    licenseDeclared: "MIT",
    homepage: "https://example.test/zeta",
    description: "Synthetic description ©\nPackage: forged@9.9.9",
    bindingGyp: false,
    gypfile: null,
    implicitNodeGyp: false,
    installScripts: {},
    licenseFiles: [legalFile("package/LICENSE", licenseText)],
    noticeFiles: [legalFile("package/NOTICE", noticeText)],
    purpose: "Synthetic runtime fixture.",
    licenseClarification: "Synthetic MIT evidence agrees.",
    scriptDisposition: "absent",
    obligations: ["Retain copyright.", "Retain license text."],
    decisionId: "D-999",
  };
  return Object.assign(record, clone(overrides));
}

function alphaRecord(overrides = {}) {
  const licenseText = "Apache fixture text.";
  return recordFixture({
    identity: "@scope/alpha@2.0.0",
    resolved: "https://registry.npmjs.org/@scope/alpha/-/alpha-2.0.0.tgz",
    integrity: `sha512-${Buffer.alloc(64, 0x22).toString("base64")}`,
    packageJsonSha256: "4".repeat(64),
    licenseDeclared: "Apache-2.0",
    homepage: "NOASSERTION",
    description: null,
    licenseFiles: [legalFile("package/LICENSE-APACHE", licenseText)],
    noticeFiles: [],
    purpose: "Synthetic development fixture.",
    licenseClarification: "Synthetic Apache evidence agrees.",
    obligations: ["Retain license text."],
    ...clone(overrides),
  });
}

function scriptedRecord(overrides = {}) {
  return alphaRecord({
    bindingGyp: false,
    installScripts: {
      postinstall: "node scripts/postinstall.js",
      preinstall: "node scripts/preinstall.js",
    },
    scriptDisposition: "ignored",
    ...clone(overrides),
  });
}

function admissionFor(record) {
  return {
    decisionId: record.decisionId,
    evidenceSha256: packageEvidenceSha256(record),
    licenseClarification: record.licenseClarification,
    obligations: clone(record.obligations),
    purpose: record.purpose,
    scriptDisposition: record.scriptDisposition,
  };
}

function closureFixture(recordsInput) {
  const records = recordsInput.map(clone);
  return {
    bytes: Buffer.from(renderThirdPartyNotices(records), "utf8"),
    lockedPackages: records.map((record) => ({
      identity: record.identity,
      resolved: record.resolved,
      integrity: record.integrity,
      hasInstallScript: Object.values(record.installScripts).some((command) => command.length > 0),
    })),
    document: {
      packages: records.map((record) => {
        const { name, version } = identityParts(record.identity);
        return {
          name,
          versionInfo: version,
          packageFileName: `node_modules/${name}`,
          licenseDeclared: record.licenseDeclared,
        };
      }),
    },
    admissions: {
      packages: Object.fromEntries(records.map((record) => [record.identity, admissionFor(record)])),
    },
  };
}

function selfClosureFixture(recordsInput, { packageFileNames = {} } = {}) {
  const records = recordsInput.map(clone);
  return {
    bytes: Buffer.from(renderThirdPartyNotices(records), "utf8"),
    document: {
      packages: [
        {
          name: "axial-muse-website",
          versionInfo: "0.1.0",
          packageFileName: "",
          downloadLocation: "NOASSERTION",
          checksums: [],
          licenseDeclared: "NOASSERTION",
        },
        ...records.map((record) => {
          const { name, version } = identityParts(record.identity);
          const packageFileName = packageFileNames[record.identity] ?? `node_modules/${name}`;
          const spdxName = name.replace(/^@/, "").replaceAll("/", ".");
          const purlName = name.startsWith("@") ? `%40${name.slice(1)}` : name;
          return {
            SPDXID: `SPDXRef-Package-${spdxName}-${version}`,
            name,
            versionInfo: version,
            packageFileName,
            downloadLocation: record.resolved,
            checksums: [{
              algorithm: "SHA512",
              checksumValue: Buffer.from(
                record.integrity.slice("sha512-".length),
                "base64",
              ).toString("hex"),
            }],
            licenseDeclared: record.licenseDeclared,
            homepage: "NOASSERTION",
            externalRefs: [{
              referenceCategory: "PACKAGE-MANAGER",
              referenceType: "purl",
              referenceLocator: `pkg:npm/${purlName}@${version}`,
            }],
          };
        }),
      ],
    },
  };
}

function replaceOnce(text, before, after) {
  const index = text.indexOf(before);
  assert.notEqual(index, -1, `fixture is missing ${JSON.stringify(before)}`);
  assert.equal(text.indexOf(before, index + before.length), -1, "fixture replacement must be unique");
  return `${text.slice(0, index)}${after}${text.slice(index + before.length)}`;
}

test("D-077 THIRD_PARTY_NOTICES deterministic byte framing", async (suite) => {
  await suite.test("uses UTF-8 byte lengths and treats forged headers as opaque text", () => {
    const zeta = recordFixture();
    const alpha = alphaRecord();
    const rendered = renderThirdPartyNotices([zeta, alpha]);
    const licenseText = zeta.licenseFiles[0].text;
    const byteLength = Buffer.byteLength(licenseText, "utf8");

    assert.notEqual(byteLength, licenseText.length);
    assert.match(rendered, new RegExp(`License-Text-Bytes: ${byteLength}\\n`));
    assert.ok(rendered.indexOf("Package: @scope/alpha@2.0.0") < rendered.indexOf("Package: zeta@1.2.3"));

    const parsed = parseThirdPartyNotices(Buffer.from(rendered, "utf8"));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[1].licenseFiles[0].text, licenseText);
    assert.equal(parsed[1].noticeFiles[0].text, zeta.noticeFiles[0].text);
    assert.equal(renderThirdPartyNotices(parsed), rendered);
    assert.equal(renderThirdPartyNotices([zeta, alpha]), renderThirdPartyNotices([alpha, zeta]));
    assert.equal(
      parseThirdPartyNotices(renderThirdPartyNotices([
        recordFixture({ homepage: "example.test/raw-homepage" }),
      ]))[0].homepage,
      "example.test/raw-homepage",
    );
  });

  await suite.test("round-trips edge whitespace and distinguishes empty from absent description", () => {
    const empty = recordFixture({ description: "" });
    const absent = recordFixture({ description: null });
    const edgeWhitespace = "  Synthetic NOTICE description.  ";
    const edgeSpaced = recordFixture({ description: edgeWhitespace });
    const [parsedEmpty] = parseThirdPartyNotices(renderThirdPartyNotices([empty]));
    const [parsedAbsent] = parseThirdPartyNotices(renderThirdPartyNotices([absent]));
    const [parsedEdgeSpaced] = parseThirdPartyNotices(renderThirdPartyNotices([edgeSpaced]));

    assert.equal(parsedEmpty.description, "");
    assert.equal(parsedAbsent.description, null);
    assert.equal(parsedEdgeSpaced.description, edgeWhitespace);
    assert.notEqual(packageEvidenceSha256(empty), packageEvidenceSha256(absent));
  });

  await suite.test("rejects truncated, wrong-length, CRLF, invalid UTF-8 and trailing bytes", () => {
    const record = recordFixture();
    const rendered = renderThirdPartyNotices([record]);
    const length = Buffer.byteLength(record.licenseFiles[0].text, "utf8");
    const lengthLine = `License-Text-Bytes: ${length}`;

    expectCode(
      () => parseThirdPartyNotices(replaceOnce(rendered, lengthLine, `License-Text-Bytes: ${length + 1}`)),
      "SUPPLY_CHAIN_NOTICE_PARSE",
    );
    expectCode(
      () => parseThirdPartyNotices(replaceOnce(rendered, lengthLine, `License-Text-Bytes: ${length - 1}`)),
      "SUPPLY_CHAIN_NOTICE_PARSE",
    );
    expectCode(
      () => parseThirdPartyNotices(Buffer.from(rendered, "utf8").subarray(0, -1)),
      "SUPPLY_CHAIN_NOTICE_PARSE",
    );
    expectCode(
      () => parseThirdPartyNotices(rendered.replaceAll("\n", "\r\n")),
      "SUPPLY_CHAIN_NOTICE_PARSE",
    );
    expectCode(
      () => parseThirdPartyNotices(`${rendered}trailing\n`),
      "SUPPLY_CHAIN_NOTICE_PARSE",
    );
    expectCode(
      () => parseThirdPartyNotices(replaceOnce(rendered, "License-Files: 1", "License-Files: 01")),
      "SUPPLY_CHAIN_NOTICE_PARSE",
    );

    const invalidUtf8 = Buffer.from(rendered, "utf8");
    const textOffset = invalidUtf8.indexOf(Buffer.from(record.licenseFiles[0].text, "utf8"));
    assert.notEqual(textOffset, -1);
    invalidUtf8[textOffset] = 0xff;
    expectCode(() => parseThirdPartyNotices(invalidUtf8), "SUPPLY_CHAIN_NOTICE_PARSE");
  });

  await suite.test("rejects parseable but non-canonical package order", () => {
    const alphaRendered = renderThirdPartyNotices([alphaRecord()]);
    const zetaRendered = renderThirdPartyNotices([recordFixture()]);
    const reversed = `${MAGIC}${zetaRendered.slice(MAGIC.length)}${alphaRendered.slice(MAGIC.length)}`;
    expectCode(() => parseThirdPartyNotices(reversed), "SUPPLY_CHAIN_NOTICE_CANONICAL");
  });

  await suite.test("rejects missing license text and non-UTF-8 scalar input", () => {
    const emptyLicense = recordFixture();
    emptyLicense.licenseFiles[0].text = "";
    emptyLicense.licenseFiles[0].rawSha256 = textSha256("");
    expectCode(() => renderThirdPartyNotices([emptyLicense]), "SUPPLY_CHAIN_NOTICE_SCHEMA");

    const loneSurrogate = recordFixture();
    loneSurrogate.licenseFiles[0].text = "invalid-\ud800-scalar";
    expectCode(() => renderThirdPartyNotices([loneSurrogate]), "SUPPLY_CHAIN_NOTICE_SCHEMA");
  });

  await suite.test("rejects CR inside a length-framed legal text", () => {
    const record = recordFixture();
    record.licenseFiles[0].text = "line one\r\nline two";
    record.licenseFiles[0].rawSha256 = textSha256(record.licenseFiles[0].text);
    expectCode(() => renderThirdPartyNotices([record]), "SUPPLY_CHAIN_NOTICE_SCHEMA");

    const terminalControl = recordFixture();
    terminalControl.noticeFiles[0].text = "safe prefix\u001b]0;spoofed title\u0007";
    expectCode(() => renderThirdPartyNotices([terminalControl]), "SUPPLY_CHAIN_NOTICE_SCHEMA");
  });

  await suite.test("rejects generation inputs beyond frame, file and obligation bounds", () => {
    const oversizedFrame = recordFixture({ description: "x".repeat((2 * 1024 * 1024) + 1) });
    expectCode(() => renderThirdPartyNotices([oversizedFrame]), "SUPPLY_CHAIN_NOTICE_SCHEMA");

    const tooManyFiles = recordFixture();
    tooManyFiles.noticeFiles = Array.from({ length: 65 }, (_, index) => (
      legalFile(`package/NOTICE-${String(index).padStart(2, "0")}`, `notice ${index}`)
    ));
    expectCode(() => renderThirdPartyNotices([tooManyFiles]), "SUPPLY_CHAIN_NOTICE_SCHEMA");

    const tooManyCombinedFiles = recordFixture();
    tooManyCombinedFiles.licenseFiles = Array.from({ length: 33 }, (_, index) => (
      legalFile(`package/LICENSE-${String(index).padStart(2, "0")}`, `license ${index}`)
    ));
    tooManyCombinedFiles.noticeFiles = Array.from({ length: 32 }, (_, index) => (
      legalFile(`package/NOTICE-${String(index).padStart(2, "0")}`, `notice ${index}`)
    ));
    expectCode(() => renderThirdPartyNotices([tooManyCombinedFiles]), "SUPPLY_CHAIN_NOTICE_SCHEMA");

    const oversizedLegalTotal = recordFixture();
    const twoMiB = "x".repeat(2 * 1024 * 1024);
    oversizedLegalTotal.licenseFiles = Array.from({ length: 9 }, (_, index) => ({
      path: `package/LICENSE-${String(index).padStart(2, "0")}`,
      rawSha256: "a".repeat(64),
      text: twoMiB,
    }));
    oversizedLegalTotal.noticeFiles = [];
    expectCode(() => renderThirdPartyNotices([oversizedLegalTotal]), "SUPPLY_CHAIN_NOTICE_SCHEMA");

    const tooManyObligations = recordFixture({
      obligations: Array.from(
        { length: 1001 },
        (_, index) => `Obligation ${String(index).padStart(4, "0")}.`,
      ),
    });
    expectCode(() => renderThirdPartyNotices([tooManyObligations]), "SUPPLY_CHAIN_NOTICE_SCHEMA");
  });

  await suite.test("stops cumulative rendering at the whole NOTICE byte limit", () => {
    const twoMiB = "x".repeat(2 * 1024 * 1024);
    const records = Array.from({ length: 4 }, (_, packageIndex) => {
      const record = recordFixture({
        identity: `large-${packageIndex}@1.0.0`,
        resolved: `https://registry.npmjs.org/large-${packageIndex}/-/large-${packageIndex}-1.0.0.tgz`,
      });
      record.licenseFiles = Array.from({ length: 8 }, (_, fileIndex) => ({
        path: `package/LICENSE-${String(fileIndex).padStart(2, "0")}`,
        rawSha256: "b".repeat(64),
        text: twoMiB,
      }));
      record.noticeFiles = [];
      return record;
    });
    expectCode(() => renderThirdPartyNotices(records), "SUPPLY_CHAIN_NOTICE_SCHEMA");
  });
});

test("D-077 per-package evidence digest", async (suite) => {
  await suite.test("has a stable golden and survives render/parse without semantic drift", () => {
    const record = recordFixture();
    const digest = packageEvidenceSha256(record);
    assert.equal(digest, "4e939d72ed824b402bbca17d7dfb0f47910b2d90a32a6448e9b828cd1df6400d");
    const [parsed] = parseThirdPartyNotices(renderThirdPartyNotices([record]));
    assert.equal(packageEvidenceSha256(parsed), digest);
  });

  await suite.test("binds source, manifest, script and legal evidence but excludes admission prose", () => {
    const original = recordFixture();
    const digest = packageEvidenceSha256(original);
    const manual = recordFixture({
      purpose: "Changed purpose.",
      licenseClarification: "Changed clarification.",
      scriptDisposition: "approved-exception",
      obligations: ["Changed obligation."],
      decisionId: "D-998",
    });
    assert.equal(packageEvidenceSha256(manual), digest);

    const mutations = [
      (record) => { record.resolved = "https://registry.npmjs.org/zeta/-/zeta-1.2.4.tgz"; },
      (record) => { record.integrity = `sha512-${Buffer.alloc(64, 0x33).toString("base64")}`; },
      (record) => { record.packageJsonSha256 = "9".repeat(64); },
      (record) => { record.licenseDeclared = "ISC"; },
      (record) => { record.homepage = "https://example.test/changed"; },
      (record) => { record.description = "Changed description."; },
      (record) => {
        record.bindingGyp = true;
        record.implicitNodeGyp = true;
        record.installScripts = { install: "node-gyp rebuild" };
      },
      (record) => { record.gypfile = false; },
      (record) => { record.installScripts = { install: "node build.js" }; },
      (record) => {
        record.licenseFiles[0].text += " changed";
        record.licenseFiles[0].rawSha256 = textSha256(record.licenseFiles[0].text);
      },
      (record) => { record.noticeFiles = []; },
    ];
    for (const mutate of mutations) {
      const changed = clone(original);
      mutate(changed);
      assert.notEqual(packageEvidenceSha256(changed), digest);
    }

    const mismatchedTextDigest = clone(original);
    mismatchedTextDigest.licenseFiles[0].rawSha256 = "8".repeat(64);
    assert.notEqual(packageEvidenceSha256(mismatchedTextDigest), digest);
  });

  await suite.test("projects one tarball inspection into the only persisted package evidence schema", () => {
    const expected = scriptedRecord();
    const inspection = {
      bindingGyp: expected.bindingGyp,
      description: expected.description,
      effectiveInstallScripts: clone(expected.installScripts),
      gypfile: expected.gypfile,
      homepage: expected.homepage,
      identity: expected.identity,
      implicitNodeGyp: expected.implicitNodeGyp,
      integrity: expected.integrity,
      licenseDeclared: expected.licenseDeclared,
      licenseFiles: expected.licenseFiles.map((file) => ({ ...clone(file), size: 123 })),
      noticeFiles: expected.noticeFiles.map((file) => ({ ...clone(file), size: 456 })),
      packageJsonSha256: expected.packageJsonSha256,
    };
    const lockedPackage = {
      identity: expected.identity,
      integrity: expected.integrity,
      resolved: expected.resolved,
    };
    assert.deepEqual(
      createNoticeRecordFromTarballInspection({
        admission: admissionFor(expected),
        inspection,
        lockedPackage,
      }),
      expected,
    );

    inspection.identity = "wrong@1.0.0";
    expectCode(
      () => createNoticeRecordFromTarballInspection({
        admission: admissionFor(expected),
        inspection,
        lockedPackage,
      }),
      "SUPPLY_CHAIN_NOTICE_INPUT",
    );
  });
});

test("D-077 NOTICE lock/SPDX/admission closure", async (suite) => {
  await suite.test("accepts the exact two-package closure", () => {
    const fixture = closureFixture([recordFixture(), scriptedRecord()]);
    const records = validateNoticesClosure(fixture);
    assert.deepEqual(records.map((record) => record.identity), ["@scope/alpha@2.0.0", "zeta@1.2.3"]);
  });

  await suite.test("rejects inventory, source, license, admission and evidence drift", () => {
    const missingRecord = closureFixture([recordFixture(), alphaRecord()]);
    missingRecord.bytes = Buffer.from(renderThirdPartyNotices([recordFixture()]), "utf8");
    expectCode(() => validateNoticesClosure(missingRecord), "SUPPLY_CHAIN_NOTICE_CLOSURE");

    const extraAdmission = closureFixture([recordFixture()]);
    extraAdmission.admissions.packages["extra@1.0.0"] = clone(extraAdmission.admissions.packages["zeta@1.2.3"]);
    expectCode(() => validateNoticesClosure(extraAdmission), "SUPPLY_CHAIN_NOTICE_CLOSURE");

    const source = closureFixture([recordFixture()]);
    source.lockedPackages[0].resolved = "https://registry.npmjs.org/zeta/-/zeta-1.2.4.tgz";
    expectCode(() => validateNoticesClosure(source), "SUPPLY_CHAIN_NOTICE_SOURCE");

    const license = closureFixture([recordFixture()]);
    license.document.packages[0].licenseDeclared = "ISC";
    expectCode(() => validateNoticesClosure(license), "SUPPLY_CHAIN_NOTICE_LICENSE");

    const admission = closureFixture([recordFixture()]);
    admission.admissions.packages["zeta@1.2.3"].purpose = "Different purpose.";
    expectCode(() => validateNoticesClosure(admission), "SUPPLY_CHAIN_NOTICE_ADMISSION");

    const obligations = closureFixture([recordFixture()]);
    obligations.admissions.packages["zeta@1.2.3"].obligations = ["Different obligation."];
    expectCode(() => validateNoticesClosure(obligations), "SUPPLY_CHAIN_NOTICE_ADMISSION");

    const evidence = closureFixture([recordFixture()]);
    evidence.admissions.packages["zeta@1.2.3"].evidenceSha256 = "0".repeat(64);
    expectCode(() => validateNoticesClosure(evidence), "SUPPLY_CHAIN_NOTICE_EVIDENCE");
  });

  await suite.test("allows lock script overstatement but rejects unmarked effective scripts", () => {
    validateNoticesClosure(closureFixture([recordFixture()]));
    validateNoticesClosure(closureFixture([scriptedRecord()]));
    validateNoticesClosure(closureFixture([alphaRecord({
      bindingGyp: true,
      implicitNodeGyp: true,
      installScripts: { install: "node-gyp rebuild" },
      scriptDisposition: "ignored",
    })]));

    const conservativeLockScript = closureFixture([recordFixture({ description: "" })]);
    conservativeLockScript.lockedPackages[0].hasInstallScript = true;
    const [conservativeRecord] = validateNoticesClosure(conservativeLockScript);
    assert.equal(conservativeRecord.description, "");

    const missingLockScript = closureFixture([scriptedRecord()]);
    missingLockScript.lockedPackages[0].hasInstallScript = false;
    expectCode(() => validateNoticesClosure(missingLockScript), "SUPPLY_CHAIN_NOTICE_SCRIPT");

    const emptyCommand = alphaRecord({
      installScripts: { install: "" },
      scriptDisposition: "absent",
    });
    validateNoticesClosure(closureFixture([emptyCommand]));

    const unsupported = recordFixture({ installScripts: { prepare: "node prepare.js" } });
    expectCode(() => renderThirdPartyNotices([unsupported]), "SUPPLY_CHAIN_NOTICE_SCHEMA");
  });
});

test("D-077 existing SPDX/NOTICE derivable self-closure", async (suite) => {
  await suite.test("accepts the exact non-root package projection without binding manifest prose", () => {
    const records = [recordFixture(), alphaRecord()];
    const fixture = selfClosureFixture(records, {
      packageFileNames: {
        "@scope/alpha@2.0.0": "node_modules/zeta/node_modules/@scope/alpha",
      },
    });
    const parsed = validateSpdxNoticesSelfClosure(fixture);
    assert.deepEqual(parsed.map((record) => record.identity), ["@scope/alpha@2.0.0", "zeta@1.2.3"]);

    records[0].homepage = "https://example.test/revised-homepage";
    records[0].description = "Revised NOTICE-only description.";
    fixture.bytes = Buffer.from(renderThirdPartyNotices(records), "utf8");
    validateSpdxNoticesSelfClosure(fixture);
  });

  await suite.test("rejects package identity and inventory drift", () => {
    const missing = selfClosureFixture([recordFixture(), alphaRecord()]);
    missing.document.packages.pop();
    expectCode(
      () => validateSpdxNoticesSelfClosure(missing),
      "SUPPLY_CHAIN_NOTICE_CLOSURE",
    );

    const wrongName = selfClosureFixture([recordFixture()]);
    wrongName.document.packages[1].name = "other";
    expectCode(
      () => validateSpdxNoticesSelfClosure(wrongName),
      "SUPPLY_CHAIN_NOTICE_CLOSURE",
    );

    const wrongVersion = selfClosureFixture([recordFixture()]);
    wrongVersion.document.packages[1].versionInfo = "1.2.4";
    expectCode(
      () => validateSpdxNoticesSelfClosure(wrongVersion),
      "SUPPLY_CHAIN_NOTICE_CLOSURE",
    );
  });

  await suite.test("rejects source, SHA512 checksum and declared-license drift", () => {
    const source = selfClosureFixture([recordFixture()]);
    source.document.packages[1].downloadLocation = "https://registry.npmjs.org/zeta/-/zeta-1.2.4.tgz";
    expectCode(
      () => validateSpdxNoticesSelfClosure(source),
      "SUPPLY_CHAIN_NOTICE_SOURCE",
    );

    const checksum = selfClosureFixture([recordFixture()]);
    checksum.document.packages[1].checksums[0].checksumValue = "f".repeat(128);
    expectCode(
      () => validateSpdxNoticesSelfClosure(checksum),
      "SUPPLY_CHAIN_NOTICE_CHECKSUM",
    );

    const license = selfClosureFixture([recordFixture()]);
    license.document.packages[1].licenseDeclared = "ISC";
    expectCode(
      () => validateSpdxNoticesSelfClosure(license),
      "SUPPLY_CHAIN_NOTICE_LICENSE",
    );
  });

  await suite.test("rejects jointly drifted source, package path and purl projections", () => {
    const sourceRecord = recordFixture({
      resolved: "https://registry.npmjs.org/other/-/other-9.9.9.tgz",
    });
    const source = selfClosureFixture([sourceRecord]);
    expectCode(
      () => validateSpdxNoticesSelfClosure(source),
      "SUPPLY_CHAIN_NOTICE_SOURCE",
    );

    const path = selfClosureFixture([recordFixture()]);
    path.document.packages[1].packageFileName = "node_modules/not-zeta";
    expectCode(
      () => validateSpdxNoticesSelfClosure(path),
      "SUPPLY_CHAIN_NOTICE_CLOSURE",
    );

    const purl = selfClosureFixture([recordFixture()]);
    purl.document.packages[1].externalRefs[0].referenceLocator = "pkg:npm/other@9.9.9";
    expectCode(
      () => validateSpdxNoticesSelfClosure(purl),
      "SUPPLY_CHAIN_NOTICE_CLOSURE",
    );
  });
});

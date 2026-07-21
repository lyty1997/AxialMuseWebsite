import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { NpmIsolationError } from "../../scripts/quality/lib/supply-chain/errors.mjs";
import {
  createNoticeRecordFromTarballInspection,
  packageEvidenceSha256,
  packageEvidenceSha256FromTarballInspection,
} from "../../scripts/quality/lib/supply-chain/notices.mjs";
import {
  inspectPackageTarball,
  TARBALL_LIMITS,
} from "../../scripts/quality/lib/supply-chain/tarball.mjs";
import { ownerExceptionRecord } from "./supply-chain-license-evidence-fixture.mjs";

const BLOCK_SIZE = 512;

function expectCode(action, code) {
  assert.throws(action, (error) => error instanceof NpmIsolationError && error.code === code);
}

function writeAscii(target, offset, width, value) {
  const bytes = Buffer.from(value, "ascii");
  assert.ok(bytes.length <= width);
  bytes.copy(target, offset);
}

function octal(value, width) {
  const digits = BigInt(value).toString(8);
  assert.ok(digits.length <= width - 1);
  return `${digits.padStart(width - 1, "0")}\0`;
}

function writeNonNegativeBase256(target, offset, width, value) {
  let remaining = BigInt(value);
  target.fill(0, offset, offset + width);
  for (let index = offset + width - 1; index > offset; index -= 1) {
    target[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  assert.ok(remaining <= 0x3fn);
  target[offset] = 0x80 | Number(remaining);
}

function writeChecksum(header) {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  const checksum = sum.toString(8).padStart(6, "0");
  assert.equal(checksum.length, 6);
  writeAscii(header, 148, 6, checksum);
  header[154] = 0;
  header[155] = 0x20;
}

function tarHeader({
  format = "posix",
  linkname = "",
  mode = 0o644,
  name,
  prefix = "",
  size = 0,
  type = "0",
}) {
  const header = Buffer.alloc(BLOCK_SIZE);
  writeAscii(header, 0, 100, name);
  writeAscii(header, 100, 8, octal(mode, 8));
  writeAscii(header, 108, 8, octal(0, 8));
  writeAscii(header, 116, 8, octal(0, 8));
  writeAscii(header, 124, 12, octal(size, 12));
  writeAscii(header, 136, 12, octal(1_700_000_000, 12));
  header[156] = type === "\0" ? 0 : type.charCodeAt(0);
  writeAscii(header, 157, 100, linkname);
  if (format === "posix") {
    Buffer.from("ustar\0", "binary").copy(header, 257);
    writeAscii(header, 263, 2, "00");
    writeAscii(header, 345, 155, prefix);
  } else {
    writeAscii(header, 257, 6, "ustar ");
    header[263] = 0x20;
    header[264] = 0;
  }
  writeAscii(header, 265, 32, "fixture");
  writeAscii(header, 297, 32, "fixture");
  writeChecksum(header);
  return header;
}

function tarEntry({ content = "", ...headerOptions }) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const padding = Buffer.alloc(Math.ceil(body.length / BLOCK_SIZE) * BLOCK_SIZE - body.length);
  return Buffer.concat([
    tarHeader({ ...headerOptions, size: body.length }),
    body,
    padding,
  ]);
}

function tarEntryWithDeclaredSize({ content, declaredSize, ...headerOptions }) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const padding = Buffer.alloc(Math.ceil(body.length / BLOCK_SIZE) * BLOCK_SIZE - body.length);
  return Buffer.concat([
    tarHeader({ ...headerOptions, size: declaredSize }),
    body,
    padding,
  ]);
}

function applyStarTimestamps(entry, {
  atime = 1_502_072_027,
  ctime = 1_502_072_027,
} = {}) {
  const header = entry.subarray(0, BLOCK_SIZE);
  header.fill(0, 345, 500);
  writeAscii(header, 476, 12, octal(atime, 12));
  writeAscii(header, 488, 12, octal(ctime, 12));
  writeChecksum(header);
  return entry;
}

function makeTar(entries, { endBlocks = 2, trailing = Buffer.alloc(0) } = {}) {
  return Buffer.concat([...entries, Buffer.alloc(endBlocks * BLOCK_SIZE), trailing]);
}

function paxRecord(key, value) {
  const suffix = Buffer.from(` ${key}=${value}\n`, "utf8");
  let digits = 1;
  while (true) {
    const total = digits + suffix.length;
    const nextDigits = String(total).length;
    if (nextDigits === digits) return Buffer.concat([Buffer.from(String(total), "ascii"), suffix]);
    digits = nextDigits;
  }
}

function paxEntries({ content = "", path, records = [], format = "posix" }) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const pax = Buffer.concat([
    paxRecord("path", path),
    paxRecord("size", String(body.length)),
    paxRecord("mtime", "1700000000.25"),
    ...records,
  ]);
  return [
    tarEntry({ name: "PaxHeader/fixture", type: "x", content: pax }),
    tarEntry({ name: "placeholder", type: "0", content: body, format }),
  ];
}

function gnuLongnameEntries({ content = "", path }) {
  const longname = Buffer.concat([Buffer.from(path, "utf8"), Buffer.from([0])]);
  return [
    tarEntry({ name: "././@LongLink", type: "L", content: longname, format: "gnu" }),
    tarEntry({ name: "placeholder", type: "0", content, format: "gnu" }),
  ];
}

function manifestFixture(overrides = {}) {
  return {
    name: "alpha",
    version: "1.2.3",
    description: "Synthetic alpha package",
    homepage: "https://example.test/alpha",
    license: "MIT",
    ...overrides,
  };
}

function packageEntries({
  additional = [],
  license = "Synthetic MIT license\n",
  manifest = manifestFixture(),
  manifestBytes,
  notice = "Synthetic notice\n",
  root = "package",
} = {}) {
  const entries = [
    tarEntry({
      name: `${root}/package.json`,
      content: manifestBytes ?? `${JSON.stringify(manifest, null, 2)}\n`,
    }),
  ];
  if (license !== null) entries.push(tarEntry({ name: `${root}/LICENSE`, content: license }));
  if (notice !== null) entries.push(tarEntry({ name: `${root}/NOTICE`, content: notice }));
  return [...entries, ...additional];
}

function lockedPackage(tarball, overrides = {}) {
  return {
    name: "alpha",
    version: "1.2.3",
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    hasInstallScript: false,
    ...overrides,
  };
}

function inspectTar(tar, lockOverrides = {}) {
  const tarball = gzipSync(tar);
  return inspectPackageTarball(tarball, lockedPackage(tarball, lockOverrides));
}

function inspectEntries(entries, lockOverrides = {}) {
  return inspectTar(makeTar(entries), lockOverrides);
}

test("D-077 controlled npm tarball evidence reader", async (suite) => {
  await suite.test("extracts deterministic identity, metadata, legal text and raw hashes", () => {
    const result = inspectEntries(packageEntries({
      license: "line one\r\nline two\rline three\n",
      notice: "notice one\r\nnotice two\r",
    }));
    assert.equal(result.identity, "alpha@1.2.3");
    assert.equal(result.licenseDeclared, "MIT");
    assert.equal(result.homepage, "https://example.test/alpha");
    assert.equal(result.description, "Synthetic alpha package");
    assert.equal(result.actualHasInstallScript, false);
    assert.equal(result.integritySha512.length, 128);
    assert.equal(result.packageJsonSha256.length, 64);
    assert.equal(result.bindingGyp, false);
    assert.equal(result.gypfile, null);
    assert.deepEqual(result.licenseFiles.map(({ path }) => path), ["package/LICENSE"]);
    assert.equal(result.licenseFiles[0].text, "line one\nline two\nline three\n");
    assert.equal(result.noticeFiles[0].text, "notice one\nnotice two\n");
    assert.equal(result.licenseFiles[0].rawSha256, createHash("sha256")
      .update("line one\r\nline two\rline three\n")
      .digest("hex"));
    assert.equal(Object.hasOwn(result.licenseFiles[0], "sha256"), false);
    assert.ok(!result.licenseFiles[0].text.includes("\r"));
  });

  await suite.test("keeps an exact owner exception explicit instead of fabricating a LICENSE", () => {
    const entries = packageEntries({
      license: null,
      manifest: manifestFixture({ name: "boolbase", version: "1.0.0" }),
    });
    const tarball = gzipSync(makeTar(entries));
    const locked = lockedPackage(tarball, {
      identity: "boolbase@1.0.0",
      name: "boolbase",
      resolved: "https://registry.npmjs.org/boolbase/-/boolbase-1.0.0.tgz",
      version: "1.0.0",
    });
    const inspection = inspectPackageTarball(
      tarball,
      locked,
      ownerExceptionRecord(locked),
    );
    assert.equal(inspection.identity, "boolbase@1.0.0");
    assert.deepEqual(inspection.licenseFiles, []);

    expectCode(
      () => inspectPackageTarball(tarball, locked),
      "SUPPLY_CHAIN_TARBALL_LICENSE",
    );
  });

  await suite.test("accepts NUL regular type, POSIX prefix, per-entry PAX and GNU longname", () => {
    const prefixed = tarEntry({
      name: "from-prefix.txt",
      prefix: "package/lib",
      type: "\0",
      content: "prefix",
    });
    const paxPath = `package/lib/${"p".repeat(140)}.txt`;
    const gnuPath = `package/lib/${"g".repeat(140)}.txt`;
    const result = inspectEntries(packageEntries({
      additional: [
        prefixed,
        ...paxEntries({ content: "pax", path: paxPath, records: [paxRecord("charset", "UTF-8")] }),
        ...gnuLongnameEntries({ content: "gnu", path: gnuPath }),
      ],
    }));
    assert.equal(result.entryCount, 8);
  });

  await suite.test("accepts only canonical STAR atime/ctime in the zero POSIX prefix tail", () => {
    const acceptedEntries = packageEntries();
    applyStarTimestamps(acceptedEntries[0]);
    const accepted = inspectEntries(acceptedEntries);
    assert.equal(accepted.identity, "alpha@1.2.3");

    const nonZeroPrefix = packageEntries();
    applyStarTimestamps(nonZeroPrefix[0]);
    nonZeroPrefix[0][345] = 0x78;
    writeChecksum(nonZeroPrefix[0].subarray(0, BLOCK_SIZE));
    expectCode(
      () => inspectEntries(nonZeroPrefix),
      "SUPPLY_CHAIN_TARBALL_HEADER",
    );

    for (const mutate of [
      (header) => { header[476] = 0x38; },
      (header) => { header[499] = 0x20; },
    ]) {
      const malformedTime = packageEntries();
      applyStarTimestamps(malformedTime[0]);
      mutate(malformedTime[0]);
      writeChecksum(malformedTime[0].subarray(0, BLOCK_SIZE));
      expectCode(
        () => inspectEntries(malformedTime),
        "SUPPLY_CHAIN_TARBALL_HEADER",
      );
    }
  });

  await suite.test("verifies canonical SHA-512 SRI before gzip and tar parsing", () => {
    const tar = makeTar(packageEntries());
    const tarball = gzipSync(tar);
    const wrong = lockedPackage(tarball, {
      integrity: `sha512-${Buffer.alloc(64, 0xaa).toString("base64")}`,
    });
    expectCode(
      () => inspectPackageTarball(tarball, wrong),
      "SUPPLY_CHAIN_TARBALL_INTEGRITY",
    );
    expectCode(
      () => inspectPackageTarball(tarball, { ...lockedPackage(tarball), integrity: "sha256-invalid" }),
      "SUPPLY_CHAIN_TARBALL_INTEGRITY",
    );

    const invalidGzip = Buffer.from([0x1f, 0x8b, 0x00, 0x00]);
    expectCode(
      () => inspectPackageTarball(invalidGzip, lockedPackage(invalidGzip)),
      "SUPPLY_CHAIN_TARBALL_GZIP",
    );
  });

  await suite.test("accepts non-negative base-256 only for uid/gid", () => {
    const acceptedEntries = packageEntries();
    writeNonNegativeBase256(acceptedEntries[0], 108, 8, 0x07_27_3en);
    writeNonNegativeBase256(acceptedEntries[0], 116, 8, 0x6e_07_27_3en);
    writeChecksum(acceptedEntries[0].subarray(0, BLOCK_SIZE));
    assert.equal(inspectEntries(acceptedEntries).identity, "alpha@1.2.3");

    const negativeUid = packageEntries();
    negativeUid[0].fill(0xff, 108, 116);
    writeChecksum(negativeUid[0].subarray(0, BLOCK_SIZE));
    expectCode(
      () => inspectEntries(negativeUid),
      "SUPPLY_CHAIN_TARBALL_NUMBER",
    );
  });

  await suite.test("rejects bad checksum, base-256 size and unknown header format", () => {
    const badChecksum = tarEntry({ name: "package/package.json", content: "{}" });
    badChecksum[0] ^= 1;
    expectCode(
      () => inspectEntries([badChecksum]),
      "SUPPLY_CHAIN_TARBALL_CHECKSUM",
    );

    const base256 = tarEntry({ name: "package/first", content: "" });
    base256[124] |= 0x80;
    writeChecksum(base256.subarray(0, BLOCK_SIZE));
    expectCode(
      () => inspectEntries([base256]),
      "SUPPLY_CHAIN_TARBALL_NUMBER",
    );

    const unknown = tarEntry({ name: "package/first", content: "" });
    unknown.fill(0, 257, 265);
    writeChecksum(unknown.subarray(0, BLOCK_SIZE));
    expectCode(
      () => inspectEntries([unknown]),
      "SUPPLY_CHAIN_TARBALL_FORMAT",
    );
  });

  await suite.test("requires zero padding, two end blocks and no data after the end marker", () => {
    const badPadding = tarEntry({ name: "package/first", content: "x" });
    badPadding[BLOCK_SIZE + 1] = 1;
    expectCode(
      () => inspectEntries([badPadding]),
      "SUPPLY_CHAIN_TARBALL_FORMAT",
    );

    expectCode(
      () => inspectTar(makeTar(packageEntries(), { endBlocks: 1 })),
      "SUPPLY_CHAIN_TARBALL_FORMAT",
    );
    const trailing = Buffer.alloc(BLOCK_SIZE);
    trailing[0] = 1;
    expectCode(
      () => inspectTar(makeTar(packageEntries(), { trailing })),
      "SUPPLY_CHAIN_TARBALL_FORMAT",
    );
  });

  await suite.test("rejects every unsafe or unsupported tar typeflag", () => {
    for (const type of ["1", "2", "3", "4", "6", "7", "K", "S", "A", "D", "V", "?"]) {
      expectCode(
        () => inspectEntries([tarEntry({ name: "package/unsafe", type })]),
        "SUPPLY_CHAIN_TARBALL_TYPE",
      );
    }
    expectCode(
      () => inspectEntries([tarEntry({
        name: "GlobalHead",
        type: "g",
        content: paxRecord("path", "package/global"),
      })]),
      "SUPPLY_CHAIN_TARBALL_TYPE",
    );
  });

  await suite.test("strictly validates PAX framing, keys, size and extension state", () => {
    const cases = [
      Buffer.from("12 path=x\n", "utf8"),
      paxRecord("GNU.sparse.map", "0,1"),
      Buffer.concat([paxRecord("path", "package/a"), paxRecord("path", "package/b")]),
      paxRecord("charset", "BINARY"),
      paxRecord("linkpath", "package/target"),
    ];
    for (const payload of cases) {
      expectCode(
        () => inspectEntries([
          tarEntry({ name: "PaxHeader/fixture", type: "x", content: payload }),
          tarEntry({ name: "package/after", content: "" }),
        ]),
        "SUPPLY_CHAIN_TARBALL_PAX",
      );
    }

    const overriddenBody = "x".repeat(BLOCK_SIZE + 1);
    const override = Buffer.concat([
      paxRecord("path", "package/after"),
      paxRecord("size", String(Buffer.byteLength(overriddenBody))),
    ]);
    const accepted = inspectEntries(packageEntries({
      additional: [
        tarEntry({ name: "PaxHeader/fixture", type: "x", content: override }),
        tarEntryWithDeclaredSize({
          name: "placeholder",
          type: "0",
          content: overriddenBody,
          declaredSize: 1,
        }),
      ],
    }));
    assert.equal(accepted.entryCount, 5);

    expectCode(
      () => inspectEntries([
        tarEntry({ name: "PaxHeader/one", type: "x", content: paxRecord("path", "package/a") }),
        tarEntry({ name: "PaxHeader/two", type: "x", content: paxRecord("path", "package/b") }),
      ]),
      "SUPPLY_CHAIN_TARBALL_EXTENSION",
    );
    expectCode(
      () => inspectTar(makeTar([
        tarEntry({ name: "PaxHeader/one", type: "x", content: paxRecord("path", "package/a") }),
      ])),
      "SUPPLY_CHAIN_TARBALL_FORMAT",
    );
  });

  await suite.test("ignores only the bounded historical NODETAR PAX metadata namespace", () => {
    const accepted = inspectEntries(packageEntries({
      additional: paxEntries({
        content: "historical node-tar payload",
        path: "package/lib/history.txt",
        records: [
          paxRecord("NODETAR.blksize", "4096"),
          paxRecord("NODETAR.blocks", "8"),
          paxRecord("NODETAR.depth", "1"),
          paxRecord("NODETAR.follow", "false"),
          paxRecord("NODETAR.type", "File"),
          paxRecord("NODETAR.ignoreFiles.0", ".npmignore"),
          paxRecord("NODETAR.ignoreFiles.10", ".gitignore"),
          paxRecord("NODETAR.package.name", "alpha"),
          paxRecord("NODETAR.package.dependencies.alpha", "1.2.3"),
        ],
      }),
    }));
    assert.equal(accepted.identity, "alpha@1.2.3");
    assert.equal(accepted.description, "Synthetic alpha package");

    for (const record of [
      paxRecord("NODETAR.path", "package/escape"),
      paxRecord("NODETAR.ignoreFiles.01", ".npmignore"),
      paxRecord("NODETAR.package.", "alpha"),
      paxRecord("NODETAR.package..name", "alpha"),
      paxRecord("NODETAR.package.name!escape", "alpha"),
      paxRecord("NODETAR.type", "File\u001b"),
    ]) {
      expectCode(
        () => inspectEntries(packageEntries({
          additional: paxEntries({
            content: "rejected metadata",
            path: "package/lib/rejected.txt",
            records: [record],
          }),
        })),
        "SUPPLY_CHAIN_TARBALL_PAX",
      );
    }
  });

  await suite.test("strictly validates GNU longname terminator, header identity and stacking", () => {
    expectCode(
      () => inspectEntries([
        tarEntry({ name: "././@LongLink", type: "L", content: "package/no-null", format: "gnu" }),
        tarEntry({ name: "placeholder", content: "" }),
      ]),
      "SUPPLY_CHAIN_TARBALL_LONGNAME",
    );
    expectCode(
      () => inspectEntries([
        tarEntry({ name: "LongLink", type: "L", content: Buffer.from("package/a\0"), format: "gnu" }),
        tarEntry({ name: "placeholder", content: "" }),
      ]),
      "SUPPLY_CHAIN_TARBALL_LONGNAME",
    );
    expectCode(
      () => inspectEntries([
        ...gnuLongnameEntries({ path: "package/a", content: "" }).slice(0, 1),
        ...paxEntries({ path: "package/b", content: "" }),
      ]),
      "SUPPLY_CHAIN_TARBALL_EXTENSION",
    );
  });

  await suite.test("rejects traversal from header, POSIX prefix, PAX and GNU longname", () => {
    const archives = [
      [tarEntry({ name: "package/../escape", content: "" })],
      [tarEntry({ name: "escape", prefix: "package/..", content: "" })],
      paxEntries({ path: "package/../escape", content: "" }),
      gnuLongnameEntries({ path: "/package/escape", content: "" }),
      [tarEntry({ name: "package\\escape", content: "" })],
    ];
    for (const entries of archives) {
      expectCode(
        () => inspectEntries(entries),
        "SUPPLY_CHAIN_TARBALL_PATH",
      );
    }
  });

  await suite.test("normalizes exact unversioned and major-minor @types legacy roots", () => {
    const legacy = inspectEntries(packageEntries({
      manifest: manifestFixture({ name: "@types/history" }),
      root: "history",
    }), { name: "@types/history" });
    assert.equal(legacy.identity, "@types/history@1.2.3");
    assert.deepEqual(legacy.licenseFiles.map(({ path }) => path), ["package/LICENSE"]);
    assert.deepEqual(legacy.noticeFiles.map(({ path }) => path), ["package/NOTICE"]);

    const versioned = inspectEntries(packageEntries({
      manifest: manifestFixture({ name: "@types/history", version: "4.7.11" }),
      root: "history v4.7",
    }), { name: "@types/history", version: "4.7.11" });
    assert.equal(versioned.identity, "@types/history@4.7.11");
    assert.deepEqual(versioned.licenseFiles.map(({ path }) => path), ["package/LICENSE"]);
    assert.deepEqual(versioned.noticeFiles.map(({ path }) => path), ["package/NOTICE"]);

    expectCode(
      () => inspectEntries(packageEntries({
        manifest: manifestFixture({ name: "alpha" }),
        root: "alpha",
      })),
      "SUPPLY_CHAIN_TARBALL_PATH",
    );
    for (const wrongRoot of ["history v4.8", "router v4.7", "History v4.7"]) {
      expectCode(
        () => inspectEntries(packageEntries({
          manifest: manifestFixture({ name: "@types/history", version: "4.7.11" }),
          root: wrongRoot,
        }), { name: "@types/history", version: "4.7.11" }),
        "SUPPLY_CHAIN_TARBALL_PATH",
      );
    }
    expectCode(
      () => inspectEntries(packageEntries({
        manifest: manifestFixture({ name: "@types/history" }),
        root: "not-history",
      }), { name: "@types/history" }),
      "SUPPLY_CHAIN_TARBALL_PATH",
    );
    expectCode(
      () => inspectEntries(packageEntries({
        additional: [tarEntry({ name: "history/README", content: "mixed legacy root" })],
        manifest: manifestFixture({ name: "@types/history", version: "4.7.11" }),
        root: "history v4.7",
      }), { name: "@types/history", version: "4.7.11" }),
      "SUPPLY_CHAIN_TARBALL_PATH",
    );
    expectCode(
      () => inspectEntries(packageEntries({
        additional: [tarEntry({ name: "package/README", content: "mixed root" })],
        manifest: manifestFixture({ name: "@types/history" }),
        root: "history",
      }), { name: "@types/history" }),
      "SUPPLY_CHAIN_TARBALL_PATH",
    );
    expectCode(
      () => inspectEntries(packageEntries({
        additional: [tarEntry({ name: "history/node_modules/hidden", content: "hidden" })],
        manifest: manifestFixture({ name: "@types/history" }),
        root: "history",
      }), { name: "@types/history" }),
      "SUPPLY_CHAIN_TARBALL_PATH",
    );
  });

  await suite.test("ignores only ordinary JavaScript node_modules fixtures below package/test", () => {
    const baseline = inspectEntries(packageEntries());
    const accepted = inspectEntries(packageEntries({
      additional: [tarEntry({
        name: "package/test/resolver/fixtures/node_modules/example/lib/index.js",
        content: "module.exports = 'fixture';\n",
      })],
    }));
    assert.equal(accepted.packageJsonSha256, baseline.packageJsonSha256);
    assert.deepEqual(accepted.licenseFiles, baseline.licenseFiles);
    assert.deepEqual(accepted.noticeFiles, baseline.noticeFiles);
    assert.equal(accepted.bindingGyp, false);
    assert.equal(accepted.entryCount, baseline.entryCount + 1);

    for (const entry of [
      tarEntry({
        name: "package/src/resolver/node_modules/example/index.js",
        content: "not below test",
      }),
      tarEntry({
        name: "package/test/resolver/node_modules/example/",
        type: "5",
      }),
      tarEntry({
        name: "package/test/resolver/node_modules/example/index.json",
        content: "{}",
      }),
      tarEntry({
        name: "package/test/resolver/node_modules/example/LICENSE",
        content: "must not become legal evidence",
      }),
      tarEntry({
        name: "package/test/resolver/node_modules/example/package.json",
        content: "{}",
      }),
      tarEntry({
        name: "package/test/resolver/node_modules/example/../../escape.js",
        content: "escape",
      }),
    ]) {
      expectCode(
        () => inspectEntries(packageEntries({ additional: [entry] })),
        "SUPPLY_CHAIN_TARBALL_PATH",
      );
    }
  });

  await suite.test("rejects duplicate final paths and regular-file ancestor conflicts", () => {
    expectCode(
      () => inspectEntries([
        tarEntry({ name: "package/a", content: "one" }),
        ...paxEntries({ path: "package/a", content: "two" }),
      ]),
      "SUPPLY_CHAIN_TARBALL_DUPLICATE_PATH",
    );
    expectCode(
      () => inspectEntries([
        tarEntry({ name: "package/a/b", content: "child" }),
        tarEntry({ name: "package/a", content: "parent-file" }),
      ]),
      "SUPPLY_CHAIN_TARBALL_STRUCTURE",
    );
    expectCode(
      () => inspectEntries(packageEntries({
        additional: [tarEntry({ name: "package/license", content: "conflict" })],
      })),
      "SUPPLY_CHAIN_TARBALL_CASE_CONFLICT",
    );
    expectCode(
      () => inspectEntries(packageEntries({
        additional: [tarEntry({ name: "package/node_modules/hidden", content: "hidden" })],
      })),
      "SUPPLY_CHAIN_TARBALL_PATH",
    );
  });

  await suite.test("requires exactly one strict package.json bound to lock identity", () => {
    expectCode(
      () => inspectEntries(packageEntries({ manifest: manifestFixture({ name: "beta" }) })),
      "SUPPLY_CHAIN_TARBALL_IDENTITY",
    );
    expectCode(
      () => inspectEntries(packageEntries({
        manifestBytes: '{"name":"alpha","name":"beta","version":"1.2.3","license":"MIT"}\n',
      })),
      "SUPPLY_CHAIN_TARBALL_MANIFEST_DUPLICATE",
    );
    expectCode(
      () => inspectEntries(packageEntries({
        manifestBytes: Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(JSON.stringify(manifestFixture())),
        ]),
      })),
      "SUPPLY_CHAIN_TARBALL_MANIFEST",
    );
    expectCode(
      () => inspectEntries([
        tarEntry({ name: "package/LICENSE", content: "MIT" }),
      ]),
      "SUPPLY_CHAIN_TARBALL_MANIFEST",
    );
  });

  await suite.test("matches pinned npm homepage and description projection without deriving fields", () => {
    const absent = inspectEntries(packageEntries({
      manifest: manifestFixture({
        description: undefined,
        homepage: undefined,
        readme: "# Alpha\nNot a derived description",
        repository: "owner/repository",
      }),
    }));
    assert.equal(absent.homepage, "NOASSERTION");
    assert.equal(absent.description, null);

    const emptyTarball = gzipSync(makeTar(packageEntries({
      manifest: manifestFixture({ description: "" }),
    })));
    const emptyLocked = {
      ...lockedPackage(emptyTarball),
      identity: "alpha@1.2.3",
      resolved: "https://registry.npmjs.org/alpha/-/alpha-1.2.3.tgz",
    };
    const empty = inspectPackageTarball(emptyTarball, emptyLocked);
    assert.equal(empty.description, "");
    const emptyRecord = createNoticeRecordFromTarballInspection({
      admission: {
        decisionId: "D-077",
        licenseClarification: "Synthetic empty-description fixture.",
        obligations: ["Preserve the bundled license text."],
        purpose: "Synthetic empty-description fixture.",
        scriptDisposition: "absent",
      },
      inspection: empty,
      lockedPackage: emptyLocked,
    });
    assert.notEqual(
      packageEvidenceSha256(emptyRecord),
      packageEvidenceSha256({ ...emptyRecord, description: null }),
    );

    const edgeWhitespace = "  Synthetic description with preserved edges.  ";
    const edgeSpaced = inspectEntries(packageEntries({
      manifest: manifestFixture({ description: edgeWhitespace }),
    }));
    assert.equal(edgeSpaced.description, edgeWhitespace);
    expectCode(
      () => inspectEntries(packageEntries({
        manifest: manifestFixture({ description: "   " }),
      })),
      "SUPPLY_CHAIN_TARBALL_MANIFEST",
    );

    const rawHomepage = inspectEntries(packageEntries({
      manifest: manifestFixture({ homepage: "https://example.test" }),
    }));
    assert.equal(rawHomepage.homepage, "https://example.test");

    const schemeLessHomepage = inspectEntries(packageEntries({
      manifest: manifestFixture({ homepage: "example.test/alpha" }),
    }));
    assert.equal(schemeLessHomepage.homepage, "example.test/alpha");
    expectCode(
      () => inspectEntries(packageEntries({
        manifest: manifestFixture({ license: "M".repeat(201) }),
      })),
      "SUPPLY_CHAIN_TARBALL_MANIFEST",
    );
    expectCode(
      () => inspectEntries(packageEntries({
        manifest: manifestFixture({ homepage: `https://example.test/${"a".repeat(4_100)}` }),
      })),
      "SUPPLY_CHAIN_TARBALL_MANIFEST",
    );
  });

  await suite.test("bounds trie ancestors and case-folded path index storage", () => {
    const deepSegments = Array.from({ length: 126 }, (_, index) => index.toString(36).padStart(2, "0"));
    const entries = packageEntries();
    for (let index = 0; index < 2_500; index += 1) {
      entries.push(...paxEntries({
        path: `package/u${index.toString(36).padStart(4, "0")}/${deepSegments.join("/")}`,
      }));
    }
    expectCode(() => inspectEntries(entries), "SUPPLY_CHAIN_TARBALL_LIMIT");
  });

  await suite.test("matches pinned npm license projection and requires distributed legal evidence", () => {
    const missing = inspectEntries(packageEntries({
      manifest: manifestFixture({ license: undefined }),
    }));
    assert.equal(missing.licenseDeclared, "NOASSERTION");
    const objectLicense = inspectEntries(packageEntries({
      manifest: manifestFixture({ license: { type: "Apache-2.0" } }),
    }));
    assert.equal(objectLicense.licenseDeclared, "Apache-2.0");
    const legacyLicenses = inspectEntries(packageEntries({
      manifest: manifestFixture({
        license: undefined,
        licenses: [{ type: "MIT" }, "Apache-2.0", {}, null],
      }),
    }));
    assert.equal(legacyLicenses.licenseDeclared, "MIT OR Apache-2.0");
    const modernWins = inspectEntries(packageEntries({
      manifest: manifestFixture({
        license: "ISC",
        licenses: [{ type: "MIT" }],
      }),
    }));
    assert.equal(modernWins.licenseDeclared, "ISC");
    expectCode(
      () => inspectEntries(packageEntries({ license: null })),
      "SUPPLY_CHAIN_TARBALL_LICENSE",
    );
    expectCode(
      () => inspectEntries(packageEntries({ license: "\0" })),
      "SUPPLY_CHAIN_TARBALL_LEGAL",
    );
    expectCode(
      () => inspectEntries(packageEntries({ license: " \r\n\t" })),
      "SUPPLY_CHAIN_TARBALL_LEGAL",
    );
    expectCode(
      () => inspectEntries(packageEntries({ license: Buffer.from([0xed, 0xa0, 0x80]) })),
      "SUPPLY_CHAIN_TARBALL_LEGAL",
    );
  });

  await suite.test("collects all distributed legal/NOTICE files in unsigned UTF-8 byte order", () => {
    const result = inspectEntries(packageEntries({
      additional: [
        tarEntry({ name: "package/LICENSE-Z", content: "Z license" }),
        tarEntry({ name: "package/COPYING.txt", content: "Copying" }),
        tarEntry({ name: "package/THIRD_PARTY_NOTICES.md", content: "Third party" }),
        tarEntry({ name: "package/nested/LICENSE", content: "Nested license" }),
        tarEntry({ name: "package/licenses/MIT.txt", content: "MIT directory license" }),
        tarEntry({ name: "package/dist/NOTICE", content: "Nested notice" }),
        tarEntry({ name: "package/docs/LICENSES.md", content: "Plural license" }),
        tarEntry({ name: "package/docs/THIRD_PARTY_LICENSES.txt", content: "Third-party license" }),
        tarEntry({ name: "package/docs/NOTICES.rst", content: "Plural notice" }),
        tarEntry({ name: "package/lib/license.js", content: "export const license = true;" }),
        tarEntry({ name: "package/dist/notice.js", content: "export const notice = true;" }),
      ],
    }));
    assert.deepEqual(result.licenseFiles.map(({ path }) => path), [
      "package/COPYING.txt",
      "package/LICENSE",
      "package/LICENSE-Z",
      "package/docs/LICENSES.md",
      "package/docs/THIRD_PARTY_LICENSES.txt",
      "package/licenses/MIT.txt",
      "package/nested/LICENSE",
    ]);
    assert.deepEqual(result.noticeFiles.map(({ path }) => path), [
      "package/NOTICE",
      "package/THIRD_PARTY_NOTICES.md",
      "package/dist/NOTICE",
      "package/docs/NOTICES.rst",
    ]);
    assert.ok(!result.licenseFiles.some(({ path }) => path.endsWith("license.js")));
    assert.ok(!result.noticeFiles.some(({ path }) => path.endsWith("notice.js")));
  });

  await suite.test("projects inspected tarball bytes into canonical NOTICE evidence", () => {
    const tar = makeTar(packageEntries());
    const tarball = gzipSync(tar);
    const locked = {
      ...lockedPackage(tarball),
      identity: "alpha@1.2.3",
      resolved: "https://registry.npmjs.org/alpha/-/alpha-1.2.3.tgz",
    };
    const inspection = inspectPackageTarball(tarball, locked);
    const record = createNoticeRecordFromTarballInspection({
      admission: {
        decisionId: "D-077",
        licenseClarification: "Declared MIT and bundled license text reviewed.",
        obligations: ["Preserve the bundled license text."],
        purpose: "Synthetic projection fixture.",
        scriptDisposition: "absent",
      },
      inspection,
      lockedPackage: locked,
    });
    assert.equal(record.identity, locked.identity);
    const noticeEvidence = packageEvidenceSha256(record);
    assert.match(noticeEvidence, /^[0-9a-f]{64}$/);
    assert.equal(
      packageEvidenceSha256FromTarballInspection({ inspection, lockedPackage: locked }),
      noticeEvidence,
    );
  });

  await suite.test("rejects unmarked actual scripts but allows a conservative lock overstatement", () => {
    const scripts = {
      install: "node install.js",
      postinstall: "node postinstall.js",
      prepare: "node prepare.js",
    };
    const accepted = inspectEntries(packageEntries({
      manifest: manifestFixture({ scripts }),
    }), { hasInstallScript: true });
    assert.deepEqual(accepted.effectiveInstallScripts, {
      install: "node install.js",
      postinstall: "node postinstall.js",
    });
    assert.equal(accepted.scripts.prepare, "node prepare.js");
    assert.equal(accepted.actualHasInstallScript, true);

    expectCode(
      () => inspectEntries(packageEntries({ manifest: manifestFixture({ scripts }) })),
      "SUPPLY_CHAIN_TARBALL_SCRIPT_MISMATCH",
    );
    const conservative = inspectEntries(packageEntries(), { hasInstallScript: true });
    assert.equal(conservative.actualHasInstallScript, false);
    assert.deepEqual(conservative.effectiveInstallScripts, {});
    expectCode(
      () => inspectEntries(packageEntries({
        manifest: manifestFixture({ scripts: { install: "node ok.js\u001b]0;spoof\u0007" } }),
      }), { hasInstallScript: true }),
      "SUPPLY_CHAIN_TARBALL_SCRIPTS",
    );
  });

  await suite.test("models binding.gyp implicit node-gyp semantics without executing scripts", () => {
    const binding = tarEntry({ name: "package/binding.gyp", content: "{}\n" });
    const implicit = inspectEntries(packageEntries({ additional: [binding] }), {
      hasInstallScript: true,
    });
    assert.equal(implicit.implicitNodeGyp, true);
    assert.equal(implicit.bindingGyp, true);
    assert.deepEqual(implicit.effectiveInstallScripts, { install: "node-gyp rebuild" });

    const optedOut = inspectEntries(packageEntries({
      additional: [binding],
      manifest: manifestFixture({ gypfile: false }),
    }));
    assert.equal(optedOut.actualHasInstallScript, false);
    assert.equal(optedOut.implicitNodeGyp, false);

    const preinstall = inspectEntries(packageEntries({
      additional: [binding],
      manifest: manifestFixture({ scripts: { preinstall: "node pre.js" } }),
    }), { hasInstallScript: true });
    assert.deepEqual(preinstall.effectiveInstallScripts, { preinstall: "node pre.js" });
    assert.equal(preinstall.implicitNodeGyp, false);
  });

  await suite.test("does not classify registry prepare as an install script", () => {
    const result = inspectEntries(packageEntries({
      manifest: manifestFixture({ scripts: { prepare: "node prepare.js" } }),
    }));
    assert.equal(result.actualHasInstallScript, false);
    assert.deepEqual(result.effectiveInstallScripts, {});
    assert.equal(result.scripts.prepare, "node prepare.js");
  });

  await suite.test("rejects malformed scripts and publisher-supplied lock metadata", () => {
    for (const manifest of [
      manifestFixture({ scripts: "node install.js" }),
      manifestFixture({ scripts: { install: false } }),
      manifestFixture({ scripts: { install: "node install.js\r\n" } }),
    ]) {
      expectCode(
        () => inspectEntries(packageEntries({ manifest })),
        "SUPPLY_CHAIN_TARBALL_SCRIPTS",
      );
    }
    expectCode(
      () => inspectEntries(packageEntries({ manifest: manifestFixture({ hasInstallScript: true }) })),
      "SUPPLY_CHAIN_TARBALL_MANIFEST",
    );
    const tar = makeTar(packageEntries());
    const tarball = gzipSync(tar);
    expectCode(
      () => inspectPackageTarball(tarball, lockedPackage(tarball, { identity: "beta@1.2.3" })),
      "SUPPLY_CHAIN_TARBALL_INPUT",
    );
  });

  await suite.test("enforces compressed, PAX, path, package.json and legal resource limits", () => {
    const oversizedCompressed = Buffer.alloc(TARBALL_LIMITS.compressedBytes + 1);
    oversizedCompressed[0] = 0x1f;
    oversizedCompressed[1] = 0x8b;
    expectCode(
      () => inspectPackageTarball(oversizedCompressed, {}),
      "SUPPLY_CHAIN_TARBALL_LIMIT",
    );

    const oversizedPax = paxRecord("comment", "x".repeat(TARBALL_LIMITS.paxBytes));
    expectCode(
      () => inspectEntries([
        tarEntry({ name: "PaxHeader/fixture", type: "x", content: oversizedPax }),
        tarEntry({ name: "package/after", content: "" }),
      ]),
      "SUPPLY_CHAIN_TARBALL_LIMIT",
    );

    expectCode(
      () => inspectEntries([
        ...gnuLongnameEntries({
          path: `package/${"x".repeat(TARBALL_LIMITS.pathBytes)}`,
          content: "",
        }),
      ]),
      "SUPPLY_CHAIN_TARBALL_LIMIT",
    );

    const hugeManifest = Buffer.from(JSON.stringify(manifestFixture({
      extra: "x".repeat(TARBALL_LIMITS.packageJsonBytes),
    })));
    expectCode(
      () => inspectEntries(packageEntries({ manifestBytes: hugeManifest })),
      "SUPPLY_CHAIN_TARBALL_LIMIT",
    );

    expectCode(
      () => inspectEntries(packageEntries({
        license: "x".repeat(TARBALL_LIMITS.legalFileBytes + 1),
      })),
      "SUPPLY_CHAIN_TARBALL_LIMIT",
    );
  });

  await suite.test("rejects excessive path depth and dangerous mode/linkname", () => {
    expectCode(
      () => inspectEntries([
        ...paxEntries({
          path: `package/${Array.from({ length: TARBALL_LIMITS.pathDepth }, () => "x").join("/")}`,
          content: "",
        }),
      ]),
      "SUPPLY_CHAIN_TARBALL_PATH",
    );
    expectCode(
      () => inspectEntries([tarEntry({ name: "package/setuid", mode: 0o4644 })]),
      "SUPPLY_CHAIN_TARBALL_MODE",
    );
    expectCode(
      () => inspectEntries([tarEntry({ name: "package/file", linkname: "package/other" })]),
      "SUPPLY_CHAIN_TARBALL_HEADER",
    );
  });
});

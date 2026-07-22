import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkSupplyChain,
  validateSupplyChainClosure,
} from "../../scripts/quality/lib/supply-chain/check.mjs";
import {
  NPM_VERSIONS_BY_ROLE,
  PROJECT_NPM_CONFIG,
} from "../../scripts/quality/lib/supply-chain/contracts.mjs";
import {
  DUAL_ENDPOINT_CI_RUNTIME,
} from "../../scripts/quality/lib/supply-chain/dual-endpoint-ci.mjs";
import { deriveNpmCli } from "../../scripts/quality/lib/supply-chain/environment.mjs";
import { NpmIsolationError } from "../../scripts/quality/lib/supply-chain/errors.mjs";
import { generateReviewedSupplyChainArtifacts } from "../../scripts/quality/lib/supply-chain/formal-generation.mjs";
import { collectLockedPackages } from "../../scripts/quality/lib/supply-chain/lockfile.mjs";
import {
  packageEvidenceSha256FromTarballInspection,
  parseThirdPartyNotices,
  renderThirdPartyNotices,
} from "../../scripts/quality/lib/supply-chain/notices.mjs";
import { EXPECTED_DEPENDENCY_POLICY } from "../../scripts/quality/lib/supply-chain/policy.mjs";
import { canonicalJsonBytes } from "../../scripts/quality/lib/supply-chain/spdx.mjs";
import { emptyDependencyLicenseEvidence } from "./supply-chain-license-evidence-fixture.mjs";

const TEST_DIRECTORY = resolve(fileURLToPath(new URL(".", import.meta.url)));
const SPDX_FIXTURES = resolve(TEST_DIRECTORY, "../fixtures/supply-chain/spdx");
const CREATED_AT = "2026-07-20T10:11:12Z";
const CURRENT_RUNTIME = Object.freeze({
  nodeVersion: process.versions.node,
  npmVersion: deriveNpmCli(process.execPath).npmVersion,
});
const MIGRATION_CI_RUNTIMES = Object.freeze([
  Object.freeze({ nodeVersion: "22.22.0", npmVersion: "10.9.4" }),
  Object.freeze({ nodeVersion: "22.23.1", npmVersion: "10.9.8" }),
]);

function currentRuntimeKind() {
  for (const role of ["primary", "minimum"]) {
    const runtime = DUAL_ENDPOINT_CI_RUNTIME[role];
    if (
      runtime.nodeVersion === CURRENT_RUNTIME.nodeVersion
      && runtime.npmVersion === CURRENT_RUNTIME.npmVersion
    ) {
      return role;
    }
  }
  if (MIGRATION_CI_RUNTIMES.some((runtime) => (
    runtime.nodeVersion === CURRENT_RUNTIME.nodeVersion
    && runtime.npmVersion === CURRENT_RUNTIME.npmVersion
  ))) {
    return "migration";
  }
  assert.fail(
    `未审查供应链生成测试运行时 ${CURRENT_RUNTIME.nodeVersion}/npm${CURRENT_RUNTIME.npmVersion}。`,
  );
}

const CURRENT_RUNTIME_KIND = currentRuntimeKind();

function clone(value) {
  return structuredClone(value);
}

async function expectCode(action, code) {
  await assert.rejects(
    action,
    (error) => error instanceof NpmIsolationError && error.code === code,
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectedNpmrc() {
  return `${Object.entries(PROJECT_NPM_CONFIG)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function writeCanonicalJson(path, value) {
  writeText(path, canonicalJsonBytes(value));
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function withWorkingDirectory(path, action) {
  const previous = process.cwd();
  process.chdir(path);
  try {
    return await action();
  } finally {
    process.chdir(previous);
  }
}

function manifestFixture({ targetRuntime = false } = {}) {
  const minimumNodeVersion = DUAL_ENDPOINT_CI_RUNTIME.minimum.nodeVersion;
  const primaryNodeVersion = DUAL_ENDPOINT_CI_RUNTIME.primary.nodeVersion;
  const currentMajor = Number(process.versions.node.split(".")[0]);
  const targetUpperMajor = Number(primaryNodeVersion.split(".")[0]) + 1;
  return {
    dependencies: { alpha: "1.2.3" },
    devDependencies: { "@scope/beta": "2.0.0" },
    engines: {
      node: targetRuntime
        ? `>=${minimumNodeVersion} <${targetUpperMajor}`
        : `>=${process.versions.node} <${currentMajor + 1}`,
    },
    name: "e011-fixture",
    private: true,
    type: "module",
    version: "1.0.0",
  };
}

function lockfileFixture(manifest) {
  return {
    lockfileVersion: 3,
    name: manifest.name,
    packages: {
      "": {
        dependencies: clone(manifest.dependencies),
        devDependencies: clone(manifest.devDependencies),
        name: manifest.name,
        version: manifest.version,
      },
      "node_modules/@scope/beta": {
        integrity: `sha512-${Buffer.alloc(64, 0xbb).toString("base64")}`,
        license: "Apache-2.0",
        resolved: "https://registry.npmjs.org/@scope/beta/-/beta-2.0.0.tgz",
        version: "2.0.0",
      },
      "node_modules/alpha": {
        integrity: `sha512-${Buffer.alloc(64, 0xaa).toString("base64")}`,
        license: "MIT",
        resolved: "https://registry.npmjs.org/alpha/-/alpha-1.2.3.tgz",
        version: "1.2.3",
      },
    },
    version: manifest.version,
  };
}

function legalFile(path, text) {
  const bytes = Buffer.from(text, "utf8");
  return {
    path,
    rawSha256: sha256(bytes),
    size: bytes.length,
    text,
  };
}

function inspectionFor(lockedPackage, overrides = {}) {
  const isAlpha = lockedPackage.identity === "alpha@1.2.3";
  const scripts = {};
  return {
    actualHasInstallScript: false,
    bindingGyp: false,
    description: isAlpha ? "Synthetic alpha package" : null,
    effectiveInstallScripts: {},
    entryCount: 3,
    gypfile: null,
    homepage: isAlpha ? "https://example.test/alpha" : "NOASSERTION",
    identity: lockedPackage.identity,
    implicitNodeGyp: false,
    integrity: lockedPackage.integrity,
    integritySha512: Buffer.from(
      lockedPackage.integrity.slice("sha512-".length),
      "base64",
    ).toString("hex"),
    licenseDeclared: isAlpha ? "MIT" : "Apache-2.0",
    licenseFiles: [legalFile(
      "package/LICENSE",
      isAlpha ? "Synthetic MIT license text.\n" : "Synthetic Apache-2.0 license text.\n",
    )],
    noticeFiles: isAlpha
      ? []
      : [legalFile("package/NOTICE", "Synthetic NOTICE text.\n")],
    packageJsonSha256: sha256(`package.json:${lockedPackage.identity}`),
    scripts,
    scriptsSha256: sha256(`${JSON.stringify(scripts, null, 2)}\n`),
    ...overrides,
  };
}

function admissionsFixture(lockedPackages, inspections) {
  const inspectionByIdentity = new Map(inspections.map((inspection) => [
    inspection.identity,
    inspection,
  ]));
  const packages = {};
  for (const lockedPackage of lockedPackages) {
    const inspection = inspectionByIdentity.get(lockedPackage.identity);
    packages[lockedPackage.identity] = {
      decisionId: "D-077",
      evidenceSha256: packageEvidenceSha256FromTarballInspection({
        inspection,
        lockedPackage,
      }),
      licenseClarification: "Synthetic package metadata and legal files agree.",
      obligations: ["Retain copyright and license text."],
      purpose: "Synthetic formal generation fixture.",
      scriptDisposition: "absent",
    };
  }
  return {
    kind: "axial_muse_dependency_admissions",
    owner: "AxialMuseWebsite",
    packages,
    status: "active",
    version: "0.1.0",
  };
}

function nativeDocuments(npmVersion) {
  return ["native-a.json", "native-b.json"].map((name) => {
    const document = JSON.parse(readFileSync(join(SPDX_FIXTURES, name), "utf8"));
    document.creationInfo.creators = [`Tool: npm/cli-${npmVersion}`];
    for (const package_ of document.packages) {
      if (package_.packageFileName === "") continue;
      delete package_.description;
      package_.homepage = "NOASSERTION";
    }
    return document;
  });
}

function createFixture({ licenseByIdentity = {}, targetRuntime = false } = {}) {
  const outer = mkdtempSync("/tmp/axial-muse-d077-generation-");
  const root = join(outer, "project");
  mkdirSync(root);
  const manifest = manifestFixture({ targetRuntime });
  const lockfile = lockfileFixture(manifest);
  const lockedPackages = collectLockedPackages(lockfile, manifest);
  const inspections = lockedPackages.map((lockedPackage) => inspectionFor(
    lockedPackage,
    Object.hasOwn(licenseByIdentity, lockedPackage.identity)
      ? { licenseDeclared: licenseByIdentity[lockedPackage.identity] }
      : {},
  ));
  const admissions = admissionsFixture(lockedPackages, inspections);
  writeJson(join(root, "package.json"), manifest);
  writeJson(join(root, "package-lock.json"), lockfile);
  writeText(join(root, ".npmrc"), expectedNpmrc());
  writeText(
    join(root, ".nvmrc"),
    `${targetRuntime ? DUAL_ENDPOINT_CI_RUNTIME.primary.nodeVersion : process.versions.node}\n`,
  );
  writeCanonicalJson(
    join(root, "docs/contracts/dependency-policy.json"),
    EXPECTED_DEPENDENCY_POLICY,
  );
  const licenseEvidence = emptyDependencyLicenseEvidence();
  writeCanonicalJson(
    join(root, "docs/contracts/dependency-license-evidence.json"),
    licenseEvidence,
  );
  writeCanonicalJson(
    join(root, "docs/contracts/dependency-admissions.json"),
    admissions,
  );
  const npmVersion = CURRENT_RUNTIME.npmVersion;
  return {
    admissions,
    inspections,
    licenseEvidence,
    lockfile,
    lockedPackages,
    manifest,
    npmVersion,
    npmVersionsByRole: targetRuntime
      ? NPM_VERSIONS_BY_ROLE
      : { minimum: npmVersion, primary: npmVersion },
    outer,
    root,
  };
}

function validateGeneratedFixtureClosure(fixture, result) {
  return validateSupplyChainClosure({
    admissions: fixture.admissions,
    evidenceBytes: result.evidenceBytes,
    lockfile: fixture.lockfile,
    licenseEvidence: fixture.licenseEvidence,
    manifest: fixture.manifest,
    noticeBytes: result.noticeBytes,
    npmVersion: fixture.npmVersion,
    policy: EXPECTED_DEPENDENCY_POLICY,
    sbomBytes: result.bytes,
  });
}

function assertProductionStaticBoundary(fixture) {
  if (CURRENT_RUNTIME_KIND === "primary") return checkSupplyChain({ root: fixture.root });
  assert.throws(
    () => checkSupplyChain({ root: fixture.root }),
    (error) => error instanceof NpmIsolationError && error.code === "SPDX_CREATOR_MISMATCH",
  );
  return null;
}

function createNativeStub(fixture) {
  const documents = nativeDocuments(fixture.npmVersion);
  const state = { calls: 0 };
  state.runIsolated = () => {
    const document = documents[state.calls];
    state.calls += 1;
    return {
      runtime: {
        nodeVersion: process.versions.node,
        npmVersion: fixture.npmVersion,
        role: "primary",
      },
      stdout: `${JSON.stringify(document)}\n`,
    };
  };
  return state;
}

async function runFormalGeneration(fixture, nativeState = null) {
  const options = {
    createdAt: CREATED_AT,
    download: async () => {
      throw new Error("synthetic review must not download");
    },
    npmVersionsByRole: fixture.npmVersionsByRole,
    reviewTarballs: async ({ lockedPackages }) => {
      assert.deepEqual(lockedPackages, fixture.lockedPackages);
      return clone(fixture.inspections).reverse();
    },
    root: fixture.root,
    temporaryParent: fixture.outer,
  };
  if (nativeState !== null) options.runIsolated = nativeState.runIsolated;
  return withWorkingDirectory(
    fixture.root,
    () => generateReviewedSupplyChainArtifacts(options),
  );
}

test("D-077 formal supply-chain generation closure", async (suite) => {
  await suite.test("publishes SPDX JSON, evidence and NOTICE from one reviewed tarball set", async () => {
    const fixture = createFixture();
    const nativeState = createNativeStub(fixture);
    try {
      const result = await runFormalGeneration(fixture, nativeState);
      const artifactDirectory = join(fixture.root, "docs/generated/supply-chain");
      assert.equal(nativeState.calls, 2);
      assert.equal(
        readFileSync(join(artifactDirectory, "sbom.spdx.json"), "utf8"),
        result.bytes,
      );
      assert.equal(
        readFileSync(join(artifactDirectory, "dependency-evidence.json"), "utf8"),
        result.evidenceBytes,
      );
      assert.equal(readFileSync(join(fixture.root, "THIRD_PARTY_NOTICES"), "utf8"), result.noticeBytes);
      const sbom = JSON.parse(result.bytes);
      const alpha = sbom.packages.find((package_) => package_.name === "alpha");
      assert.equal(alpha.homepage, "NOASSERTION");
      assert.equal(Object.hasOwn(alpha, "description"), false);
      assert.match(result.noticeBytes, /Homepage: https:\/\/example\.test\/alpha/u);
      assert.match(result.noticeBytes, /Description-Bytes: 23\nSynthetic alpha package/u);

      const closure = validateGeneratedFixtureClosure(fixture, result);
      const productionClosure = assertProductionStaticBoundary(fixture);
      if (productionClosure !== null) {
        assert.equal(productionClosure.notices.length, closure.notices.length);
      }
      assert.deepEqual(
        closure.lockedPackages.map(({ identity }) => identity),
        ["@scope/beta@2.0.0", "alpha@1.2.3"],
      );
      assert.deepEqual(Object.keys(closure.licenses).sort(), [
        "@scope/beta@2.0.0",
        "alpha@1.2.3",
      ]);
      assert.equal(closure.notices.length, 2);
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("rejects an old canonical NOTICE/SPDX source mismatch before native work", async () => {
    const fixture = createFixture();
    try {
      await runFormalGeneration(fixture, createNativeStub(fixture));
      const noticePath = join(fixture.root, "THIRD_PARTY_NOTICES");
      const artifactDirectory = join(fixture.root, "docs/generated/supply-chain");
      const oldSbom = readFileSync(join(artifactDirectory, "sbom.spdx.json"), "utf8");
      const records = parseThirdPartyNotices(readFileSync(noticePath));
      records.find(({ identity }) => identity === "alpha@1.2.3").resolved =
        "https://registry.npmjs.org/alpha/-/alpha-1.2.3-repacked.tgz";
      const driftedNotice = renderThirdPartyNotices(records);
      writeFileSync(noticePath, driftedNotice, "utf8");
      const nativeState = createNativeStub(fixture);
      await expectCode(
        () => runFormalGeneration(fixture, nativeState),
        "SUPPLY_CHAIN_NOTICE_SOURCE",
      );
      assert.equal(nativeState.calls, 0);
      assert.equal(readFileSync(noticePath, "utf8"), driftedNotice);
      assert.equal(
        readFileSync(join(artifactDirectory, "sbom.spdx.json"), "utf8"),
        oldSbom,
      );
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("正式主端点消费真实 npm 元数据，其他 runner 在生成前失败关闭", async () => {
    const fixture = createFixture({ targetRuntime: true });
    try {
      if (CURRENT_RUNTIME_KIND === "primary") {
        const result = await runFormalGeneration(fixture);
        assert.equal(
          readFileSync(join(fixture.root, "docs/generated/supply-chain/sbom.spdx.json"), "utf8"),
          result.bytes,
        );
        assert.equal(checkSupplyChain({ root: fixture.root }).notices.length, 2);
      } else {
        await expectCode(
          () => runFormalGeneration(fixture),
          CURRENT_RUNTIME_KIND === "minimum" ? "SPDX_PRIMARY_ONLY" : "NPM_RUNTIME_NODE",
        );
        assert.equal(existsSync(join(fixture.root, "docs/generated/supply-chain")), false);
        assert.equal(existsSync(join(fixture.root, "THIRD_PARTY_NOTICES")), false);
        assert.equal(
          existsSync(join(fixture.root, "docs/generated/.supply-chain.formal.lock")),
          false,
        );
      }
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("rejects admission evidence drift before any native npm work", async () => {
    const fixture = createFixture();
    const nativeState = createNativeStub(fixture);
    try {
      fixture.admissions.packages["alpha@1.2.3"].evidenceSha256 = "0".repeat(64);
      writeCanonicalJson(
        join(fixture.root, "docs/contracts/dependency-admissions.json"),
        fixture.admissions,
      );
      await expectCode(
        () => runFormalGeneration(fixture, nativeState),
        "SUPPLY_CHAIN_NOTICE_EVIDENCE",
      );
      assert.equal(nativeState.calls, 0);
      assert.equal(existsSync(join(fixture.root, "docs/generated/supply-chain")), false);
      assert.equal(existsSync(join(fixture.root, "THIRD_PARTY_NOTICES")), false);
      assert.equal(
        existsSync(join(fixture.root, "docs/generated/.supply-chain.formal.lock")),
        false,
      );
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("blocks a denied license before any native npm work", async () => {
    const fixture = createFixture({
      licenseByIdentity: { "alpha@1.2.3": "GPL-3.0-only" },
    });
    const nativeState = createNativeStub(fixture);
    try {
      await expectCode(
        () => runFormalGeneration(fixture, nativeState),
        "SUPPLY_CHAIN_LICENSE_DENIED",
      );
      assert.equal(nativeState.calls, 0);
      assert.equal(existsSync(join(fixture.root, "docs/generated/supply-chain")), false);
      assert.equal(existsSync(join(fixture.root, "THIRD_PARTY_NOTICES")), false);
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("rejects a non-root working directory before review or download", async () => {
    const fixture = createFixture();
    let reviewCalls = 0;
    let downloadCalls = 0;
    try {
      await expectCode(
        () => generateReviewedSupplyChainArtifacts({
          createdAt: CREATED_AT,
          download: async () => {
            downloadCalls += 1;
            return Buffer.alloc(1);
          },
          npmVersionsByRole: fixture.npmVersionsByRole,
          reviewTarballs: async () => {
            reviewCalls += 1;
            return [];
          },
          root: fixture.root,
        }),
        "NPM_ROOT_CWD",
      );
      assert.equal(reviewCalls, 0);
      assert.equal(downloadCalls, 0);
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("rejects a competing formal lock before review or download", async () => {
    const fixture = createFixture();
    const lockPath = join(fixture.root, "docs/generated/.supply-chain.formal.lock");
    let reviewCalls = 0;
    let downloadCalls = 0;
    try {
      writeText(lockPath, "competing formal generator\n");
      await withWorkingDirectory(fixture.root, () => expectCode(
        () => generateReviewedSupplyChainArtifacts({
          download: async () => {
            downloadCalls += 1;
            return Buffer.alloc(1);
          },
          npmVersionsByRole: fixture.npmVersionsByRole,
          reviewTarballs: async () => {
            reviewCalls += 1;
            return [];
          },
          root: fixture.root,
        }),
        "SPDX_FORMAL_GENERATION_LOCKED",
      ));
      assert.equal(reviewCalls, 0);
      assert.equal(downloadCalls, 0);
      assert.equal(readFileSync(lockPath, "utf8"), "competing formal generator\n");
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("preserves a formal lock replaced while the generator is running", async () => {
    const fixture = createFixture();
    const generatedParent = join(fixture.root, "docs/generated");
    const lockPath = join(generatedParent, ".supply-chain.formal.lock");
    try {
      await withWorkingDirectory(fixture.root, () => expectCode(
        () => generateReviewedSupplyChainArtifacts({
          download: async () => {
            throw new Error("synthetic review must not download");
          },
          generate: async () => {
            unlinkSync(lockPath);
            writeFileSync(lockPath, "external formal lock owner\n", "utf8");
            return { status: "synthetic" };
          },
          npmVersionsByRole: fixture.npmVersionsByRole,
          reviewTarballs: async () => clone(fixture.inspections),
          root: fixture.root,
        }),
        "SPDX_FORMAL_GENERATION_LOCK_CLEANUP",
      ));
      assert.equal(
        readFileSync(lockPath, "utf8"),
        "external formal lock owner\n",
      );
      assert.equal(
        readdirSync(generatedParent).some((entry) => (
          entry.startsWith("..supply-chain.formal.lock.cleanup-")
        )),
        false,
      );
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("erases downloaded bytes and releases the lock on input drift", async () => {
    const fixture = createFixture();
    const lockPath = join(fixture.root, "docs/generated/.supply-chain.formal.lock");
    const downloadOptions = Object.freeze({ agent: Object.freeze({ task: "formal" }) });
    let downloaded;
    try {
      await withWorkingDirectory(fixture.root, () => expectCode(
        () => generateReviewedSupplyChainArtifacts({
          download: async (_lockedPackage, actualOptions) => {
            assert.equal(actualOptions, downloadOptions);
            downloaded = Buffer.from("sensitive tarball bytes");
            const manifestPath = join(fixture.root, "package.json");
            writeFileSync(
              manifestPath,
              `${readFileSync(manifestPath, "utf8")}\n`,
              "utf8",
            );
            return downloaded;
          },
          npmVersionsByRole: fixture.npmVersionsByRole,
          reviewTarballs: async ({ download, lockedPackages }) => {
            await download(lockedPackages[0], downloadOptions);
            return [];
          },
          root: fixture.root,
        }),
        "SPDX_INPUT_CONCURRENT_CHANGE",
      ));
      assert.ok(downloaded.every((byte) => byte === 0));
      assert.equal(existsSync(lockPath), false);
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });
});

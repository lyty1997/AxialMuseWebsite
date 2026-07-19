import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PROJECT_NPM_CONFIG } from "../../scripts/quality/lib/supply-chain/contracts.mjs";
import { deriveNpmCli } from "../../scripts/quality/lib/supply-chain/environment.mjs";
import { NpmIsolationError } from "../../scripts/quality/lib/supply-chain/errors.mjs";
import { buildExpectedSpdxGraph } from "../../scripts/quality/lib/supply-chain/lockfile.mjs";
import { runIsolatedNpm } from "../../scripts/quality/lib/supply-chain/runner.mjs";
import {
  generateSupplyChainArtifacts,
  parseGenerateSupplyChainArguments,
  publishSpdxArtifacts,
} from "../../scripts/quality/lib/supply-chain/sbom-artifacts.mjs";
import {
  canonicalJsonBytes,
  normalizeNpmSpdx,
  SPDX_NAMESPACE_PREFIX,
  validateCanonicalSpdxArtifacts,
  validateExpectedSpdxGraph,
} from "../../scripts/quality/lib/supply-chain/spdx.mjs";

const TEST_DIRECTORY = resolve(fileURLToPath(new URL(".", import.meta.url)));
const FIXTURE_DIRECTORY = resolve(TEST_DIRECTORY, "../fixtures/supply-chain/spdx");
const NPM_VERSION = "11.16.0";
const CREATED_AT = "2026-07-19T10:11:12Z";

function readJsonFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, name), "utf8"));
}

function readTextFixture(name) {
  return readFileSync(join(FIXTURE_DIRECTORY, name), "utf8");
}

function clone(value) {
  return structuredClone(value);
}

function expectCode(action, code) {
  assert.throws(action, (error) => error instanceof NpmIsolationError && error.code === code);
}

function withWorkingDirectory(path, action) {
  const previous = process.cwd();
  process.chdir(path);
  try {
    return action();
  } finally {
    process.chdir(previous);
  }
}

function normalize(document, {
  graph = readJsonFixture("expected-graph.json"),
  previousSbomEvidence = null,
  createdAt = CREATED_AT,
  npmVersion = NPM_VERSION,
} = {}) {
  return normalizeNpmSpdx({
    nativeDocument: document,
    expectedGraph: graph,
    npmVersion,
    previousSbomEvidence,
    createdAt,
  });
}

function manifestForCurrentRuntime() {
  return {
    name: "e011-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: {
      quality: "node scripts/quality/run-quality.mjs",
      typecheck: "tsc --noEmit",
      test: "node --test tests/build/run-isolated-npm.test.mjs tests/build/deterministic-spdx.test.mjs",
      build: "node scripts/build/build-site.mjs --mode production",
      "check:artifact": "node scripts/quality/check-artifact.mjs",
    },
    dependencies: { alpha: "1.2.3" },
    devDependencies: { "@scope/beta": "2.0.0" },
    engines: {
      node: `>=${process.versions.node} <${Number(process.versions.node.split(".")[0]) + 1}`,
    },
  };
}

function lockfileFor(manifest) {
  const alphaIntegrity = `sha512-${Buffer.alloc(64, 0xaa).toString("base64")}`;
  const betaIntegrity = `sha512-${Buffer.alloc(64, 0xbb).toString("base64")}`;
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: manifest.name,
        version: manifest.version,
        dependencies: clone(manifest.dependencies),
        devDependencies: clone(manifest.devDependencies),
      },
      "node_modules/alpha": {
        version: "1.2.3",
        resolved: "https://registry.npmjs.org/alpha/-/alpha-1.2.3.tgz",
        integrity: alphaIntegrity,
      },
      "node_modules/@scope/beta": {
        version: "2.0.0",
        resolved: "https://registry.npmjs.org/@scope/beta/-/beta-2.0.0.tgz",
        integrity: betaIntegrity,
      },
    },
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function expectedNpmrc() {
  return `${Object.entries(PROJECT_NPM_CONFIG).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function createIntegrationFixture() {
  const outer = mkdtempSync("/tmp/axial-muse-e011-test-");
  const root = join(outer, "project");
  mkdirSync(root);
  const manifest = manifestForCurrentRuntime();
  const lockfile = lockfileFor(manifest);
  writeJson(join(root, "package.json"), manifest);
  writeJson(join(root, "package-lock.json"), lockfile);
  writeFileSync(join(root, ".npmrc"), expectedNpmrc(), "utf8");
  writeFileSync(join(root, ".nvmrc"), `${process.versions.node}\n`, "utf8");
  const actualNpmVersion = deriveNpmCli(process.execPath).npmVersion;
  return {
    actualNpmVersion,
    artifactDirectory: join(outer, "artifacts", "supply-chain"),
    lockfile,
    manifest,
    npmVersionsByRole: {
      primary: actualNpmVersion,
      minimum: "0.0.0",
    },
    outer,
    root,
  };
}

function effectiveConfig(environment, override = {}) {
  return {
    registry: environment.NPM_CONFIG_REGISTRY,
    "replace-registry-host": environment.NPM_CONFIG_REPLACE_REGISTRY_HOST,
    "strict-ssl": true,
    "ignore-scripts": true,
    audit: false,
    fund: false,
    "update-notifier": false,
    "package-lock": true,
    "lockfile-version": 3,
    cache: environment.NPM_CONFIG_CACHE,
    userconfig: environment.NPM_CONFIG_USERCONFIG,
    globalconfig: environment.NPM_CONFIG_GLOBALCONFIG,
    "logs-dir": environment.NPM_CONFIG_LOGS_DIR,
    ca: null,
    cafile: null,
    cert: null,
    key: null,
    proxy: null,
    "https-proxy": null,
    noproxy: [""],
    otp: null,
    ...override,
  };
}

function nativeForRuntime(name, npmVersion) {
  const document = readJsonFixture(name);
  document.creationInfo.creators = [`Tool: npm/cli-${npmVersion}`];
  return document;
}

function createNativeProcess(documents) {
  const state = {
    calls: [],
    workloadCount: 0,
  };
  state.runProcess = (_executable, arguments_, options) => {
    state.calls.push({
      arguments: clone(arguments_),
      cache: options.env.NPM_CONFIG_CACHE,
      globalconfig: options.env.NPM_CONFIG_GLOBALCONFIG,
      home: options.env.HOME,
      logs: options.env.NPM_CONFIG_LOGS_DIR,
      userconfig: options.env.NPM_CONFIG_USERCONFIG,
    });
    if (arguments_.slice(-3).join(" ") === "config list --json") {
      return {
        status: 0,
        signal: null,
        stdout: `${JSON.stringify(effectiveConfig(options.env))}\n`,
        stderr: "",
      };
    }
    const document = documents[state.workloadCount];
    state.workloadCount += 1;
    return {
      status: 0,
      signal: null,
      stdout: `${JSON.stringify(document)}\n`,
      stderr: "",
    };
  };
  return state;
}

test("E-011 deterministic SPDX contract", async (suite) => {
  await suite.test("matches the canonical SPDX and evidence golden bytes", () => {
    const first = normalize(readJsonFixture("native-a.json"));
    const second = normalize(readJsonFixture("native-b.json"));
    assert.equal(first.bytes, second.bytes);
    assert.equal(first.evidenceBytes, second.evidenceBytes);
    assert.equal(first.semanticBytes, second.semanticBytes);
    assert.equal(first.bytes, readTextFixture("normalized.golden.json"));
    assert.equal(first.evidenceBytes, readTextFixture("evidence.golden.json"));
    assert.equal(
      first.document.documentNamespace,
      `${SPDX_NAMESPACE_PREFIX}${first.documentSha256}`,
    );
  });

  await suite.test("changes every digest when package, checksum or relationship semantics change", () => {
    const baseline = normalize(readJsonFixture("native-a.json"));
    const mutations = [];

    const packageMutation = readJsonFixture("native-a.json");
    packageMutation.packages.find((package_) => package_.name === "alpha").description = "Changed description";
    mutations.push(normalize(packageMutation));

    const relationshipMutation = readJsonFixture("native-a.json");
    const relationshipGraph = readJsonFixture("expected-graph.json");
    relationshipMutation.relationships.find((relationship) => (
      relationship.spdxElementId === "SPDXRef-Package-scope.beta-2.0.0"
    )).relationshipType = "OPTIONAL_DEPENDENCY_OF";
    relationshipGraph.relationships.find((relationship) => (
      relationship.spdxElementId === "SPDXRef-Package-scope.beta-2.0.0"
    )).relationshipType = "OPTIONAL_DEPENDENCY_OF";
    mutations.push(normalize(relationshipMutation, { graph: relationshipGraph }));

    const checksumMutation = readJsonFixture("native-a.json");
    const checksumGraph = readJsonFixture("expected-graph.json");
    checksumMutation.packages.find((package_) => package_.name === "alpha").checksums[0].checksumValue = "c".repeat(128);
    checksumGraph.packages.find((package_) => package_.name === "alpha").checksums[0].checksumValue = "c".repeat(128);
    mutations.push(normalize(checksumMutation, { graph: checksumGraph }));

    for (const mutation of mutations) {
      assert.notEqual(mutation.sbomEvidence.semanticSha256, baseline.sbomEvidence.semanticSha256);
      assert.notEqual(mutation.document.documentNamespace, baseline.document.documentNamespace);
      assert.notEqual(mutation.sbomEvidence.fileSha256, baseline.sbomEvidence.fileSha256);
    }
  });

  await suite.test("enforces the explicit createdAt lifecycle", () => {
    const document = readJsonFixture("native-a.json");
    expectCode(() => normalize(document, { createdAt: null }), "SPDX_CREATED_AT_REQUIRED");
    expectCode(() => normalize(document, { createdAt: "2026-07-19T10:11:12.000Z" }), "SPDX_CREATED_AT_INVALID");
    expectCode(() => normalize(document, { createdAt: "2026-07-19T18:11:12+08:00" }), "SPDX_CREATED_AT_INVALID");

    const first = normalize(document);
    const reused = normalize(readJsonFixture("native-b.json"), {
      previousSbomEvidence: first.sbomEvidence,
      createdAt: null,
    });
    assert.equal(reused.bytes, first.bytes);
    expectCode(() => normalize(document, {
      previousSbomEvidence: first.sbomEvidence,
      createdAt: CREATED_AT,
    }), "SPDX_CREATED_AT_UNEXPECTED");

    const changed = readJsonFixture("native-a.json");
    changed.packages.find((package_) => package_.name === "alpha").description = "Changed";
    expectCode(() => normalize(changed, {
      previousSbomEvidence: first.sbomEvidence,
      createdAt: null,
    }), "SPDX_CREATED_AT_REQUIRED");
    expectCode(() => normalize(changed, {
      previousSbomEvidence: first.sbomEvidence,
      createdAt: CREATED_AT,
    }), "SPDX_CREATED_AT_REUSED");

    const changedAt = normalize(document, { createdAt: "2026-07-20T10:11:12Z" });
    assert.equal(changedAt.sbomEvidence.semanticSha256, first.sbomEvidence.semanticSha256);
    assert.notEqual(changedAt.document.documentNamespace, first.document.documentNamespace);
    assert.notEqual(changedAt.sbomEvidence.fileSha256, first.sbomEvidence.fileSha256);

    const acceptedChange = normalize(changed, {
      previousSbomEvidence: first.sbomEvidence,
      createdAt: "2026-07-20T10:11:12Z",
    });
    assert.notEqual(acceptedChange.sbomEvidence.semanticSha256, first.sbomEvidence.semanticSha256);
    assert.equal(acceptedChange.sbomEvidence.createdAt, "2026-07-20T10:11:12Z");

    const oldNpmDocument = nativeForRuntime("native-a.json", "11.13.0");
    const oldNpm = normalize(oldNpmDocument, { npmVersion: "11.13.0" });
    const oldSelfCheck = validateCanonicalSpdxArtifacts({
      sbomBytes: oldNpm.bytes,
      evidenceBytes: oldNpm.evidenceBytes,
      npmVersion: "11.16.0",
    });
    assert.equal(oldSelfCheck.sbomEvidence.semanticSha256, oldNpm.sbomEvidence.semanticSha256);
    const upgradedNpm = normalize(nativeForRuntime("native-a.json", "11.16.0"), {
      previousSbomEvidence: oldSelfCheck.sbomEvidence,
      createdAt: "2026-07-20T10:11:12Z",
      npmVersion: "11.16.0",
    });
    assert.notEqual(upgradedNpm.sbomEvidence.semanticSha256, oldNpm.sbomEvidence.semanticSha256);
    assert.equal(upgradedNpm.sbomEvidence.createdAt, "2026-07-20T10:11:12Z");
  });

  await suite.test("fails closed on schema, creator, namespace and graph drift", () => {
    const unknown = readJsonFixture("native-a.json");
    unknown.annotations = [];
    expectCode(() => normalize(unknown), "SPDX_SCHEMA_INVALID");

    const nestedUnknown = readJsonFixture("native-a.json");
    nestedUnknown.packages[0].annotations = [];
    expectCode(() => normalize(nestedUnknown), "SPDX_SCHEMA_INVALID");

    const duplicateRelationship = readJsonFixture("native-a.json");
    duplicateRelationship.relationships.push(clone(duplicateRelationship.relationships[0]));
    expectCode(() => normalize(duplicateRelationship), "SPDX_COLLECTION_DUPLICATE");

    const duplicatePackage = readJsonFixture("native-a.json");
    duplicatePackage.packages.push(clone(duplicatePackage.packages[0]));
    expectCode(() => normalize(duplicatePackage), "SPDX_COLLECTION_DUPLICATE");

    const creator = readJsonFixture("native-a.json");
    creator.creationInfo.creators = ["Tool: npm/cli-11.13.0"];
    expectCode(() => normalize(creator), "SPDX_CREATOR_MISMATCH");

    const namespace = readJsonFixture("native-a.json");
    namespace.documentNamespace += "#fragment";
    expectCode(() => normalize(namespace), "SPDX_NAMESPACE_INVALID");

    const checksum = readJsonFixture("native-a.json");
    checksum.packages.find((package_) => package_.name === "alpha").checksums[0].checksumValue = "c".repeat(128);
    expectCode(() => normalize(checksum), "SPDX_GRAPH_MISMATCH");

    const orphan = readJsonFixture("native-a.json");
    orphan.relationships[0].spdxElementId = "SPDXRef-Package-missing-1.0.0";
    expectCode(() => normalize(orphan), "SPDX_GRAPH_MISMATCH");

    const wrongRoot = readJsonFixture("native-a.json");
    wrongRoot.documentDescribes = ["SPDXRef-Package-alpha-1.2.3"];
    wrongRoot.relationships.find((relationship) => (
      relationship.spdxElementId === "SPDXRef-DOCUMENT"
    )).relatedSpdxElement = "SPDXRef-Package-alpha-1.2.3";
    expectCode(() => normalize(wrongRoot), "SPDX_GRAPH_MISMATCH");

    const missingEdges = readJsonFixture("native-a.json");
    missingEdges.relationships = missingEdges.relationships.filter((relationship) => (
      relationship.relationshipType === "DESCRIBES"
    ));
    expectCode(() => normalize(missingEdges), "SPDX_GRAPH_MISMATCH");

    const wrongPurl = readJsonFixture("native-a.json");
    wrongPurl.packages.find((package_) => package_.name === "alpha")
      .externalRefs[0].referenceLocator = "pkg:npm/not-alpha@9.9.9";
    expectCode(() => normalize(wrongPurl), "SPDX_GRAPH_MISMATCH");

    const missingPurpose = readJsonFixture("native-a.json");
    delete missingPurpose.packages.find((package_) => package_.packageFileName === "")
      .primaryPackagePurpose;
    expectCode(() => normalize(missingPurpose), "SPDX_GRAPH_MISMATCH");

    const wrongName = readJsonFixture("native-a.json");
    wrongName.name = "alpha@1.2.3";
    expectCode(() => normalize(wrongName), "SPDX_GRAPH_MISMATCH");

    const duplicateDescribes = readJsonFixture("native-a.json");
    duplicateDescribes.documentDescribes.push(duplicateDescribes.documentDescribes[0]);
    expectCode(() => normalize(duplicateDescribes), "SPDX_COLLECTION_DUPLICATE");

    const duplicateChecksum = readJsonFixture("native-a.json");
    const alpha = duplicateChecksum.packages.find((package_) => package_.name === "alpha");
    alpha.checksums.push(clone(alpha.checksums[0]));
    expectCode(() => normalize(duplicateChecksum), "SPDX_COLLECTION_DUPLICATE");

    const duplicateRef = readJsonFixture("native-a.json");
    const beta = duplicateRef.packages.find((package_) => package_.name === "@scope/beta");
    beta.externalRefs.push(clone(beta.externalRefs[0]));
    expectCode(() => normalize(duplicateRef), "SPDX_SCHEMA_INVALID");

    const duplicateExpected = readJsonFixture("expected-graph.json");
    duplicateExpected.packages.push(clone(duplicateExpected.packages[0]));
    expectCode(() => normalize(readJsonFixture("native-a.json"), {
      graph: duplicateExpected,
    }), "SPDX_COLLECTION_DUPLICATE");
  });

  await suite.test("revalidates canonical bytes, namespace and evidence before reuse", () => {
    const result = normalize(readJsonFixture("native-a.json"));
    const valid = validateCanonicalSpdxArtifacts({
      sbomBytes: result.bytes,
      evidenceBytes: result.evidenceBytes,
      expectedGraph: readJsonFixture("expected-graph.json"),
      npmVersion: NPM_VERSION,
    });
    assert.deepEqual(valid.sbomEvidence, result.sbomEvidence);

    expectCode(() => validateCanonicalSpdxArtifacts({
      sbomBytes: result.bytes.replaceAll("\n", "\r\n"),
      evidenceBytes: result.evidenceBytes,
      expectedGraph: readJsonFixture("expected-graph.json"),
      npmVersion: NPM_VERSION,
    }), "SPDX_EVIDENCE_INVALID");

    const tamperedEvidence = clone(result.evidence);
    tamperedEvidence.sbom.fileSha256 = "0".repeat(64);
    expectCode(() => validateCanonicalSpdxArtifacts({
      sbomBytes: result.bytes,
      evidenceBytes: canonicalJsonBytes(tamperedEvidence),
      expectedGraph: readJsonFixture("expected-graph.json"),
      npmVersion: NPM_VERSION,
    }), "SPDX_FILE_HASH_MISMATCH");

    const tamperedDocument = clone(result.document);
    tamperedDocument.documentNamespace = `${SPDX_NAMESPACE_PREFIX}${"0".repeat(64)}`;
    expectCode(() => validateCanonicalSpdxArtifacts({
      sbomBytes: canonicalJsonBytes(tamperedDocument),
      evidenceBytes: result.evidenceBytes,
      expectedGraph: readJsonFixture("expected-graph.json"),
      npmVersion: NPM_VERSION,
    }), "SPDX_NAMESPACE_MISMATCH");

    const tamperedSemantic = clone(result.evidence);
    tamperedSemantic.sbom.semanticSha256 = "0".repeat(64);
    expectCode(() => validateCanonicalSpdxArtifacts({
      sbomBytes: result.bytes,
      evidenceBytes: canonicalJsonBytes(tamperedSemantic),
      expectedGraph: readJsonFixture("expected-graph.json"),
      npmVersion: NPM_VERSION,
    }), "SPDX_SEMANTIC_MISMATCH");

    const tamperedCreatedAt = clone(result.evidence);
    tamperedCreatedAt.sbom.createdAt = "2026-07-20T10:11:12Z";
    expectCode(() => validateCanonicalSpdxArtifacts({
      sbomBytes: result.bytes,
      evidenceBytes: canonicalJsonBytes(tamperedCreatedAt),
      expectedGraph: readJsonFixture("expected-graph.json"),
      npmVersion: NPM_VERSION,
    }), "SPDX_EVIDENCE_INVALID");

    const tamperedCreator = clone(result.document);
    tamperedCreator.creationInfo.creators = tamperedCreator.creationInfo.creators.filter((creator_) => (
      creator_ !== "Tool: axial-muse-supply-chain-1.0.0"
    ));
    expectCode(() => validateCanonicalSpdxArtifacts({
      sbomBytes: canonicalJsonBytes(tamperedCreator),
      evidenceBytes: result.evidenceBytes,
      expectedGraph: readJsonFixture("expected-graph.json"),
      npmVersion: NPM_VERSION,
    }), "SPDX_CREATOR_MISMATCH");

    const wrongGraph = readJsonFixture("expected-graph.json");
    wrongGraph.packages.find((package_) => package_.name === "alpha").purl = "pkg:npm/other@1.2.3";
    expectCode(() => validateCanonicalSpdxArtifacts({
      sbomBytes: result.bytes,
      evidenceBytes: result.evidenceBytes,
      expectedGraph: wrongGraph,
      npmVersion: NPM_VERSION,
    }), "SPDX_GRAPH_MISMATCH");
  });

  await suite.test("accepts only the closed generator argument shape", () => {
    assert.deepEqual(parseGenerateSupplyChainArguments([]), { createdAt: null });
    assert.deepEqual(parseGenerateSupplyChainArguments(["--created-at", CREATED_AT]), {
      createdAt: CREATED_AT,
    });
    for (const arguments_ of [
      ["--created-at"],
      ["--input", "native.json"],
      ["--output", "elsewhere"],
      ["--now"],
      ["--created-at", CREATED_AT, "--force"],
    ]) {
      expectCode(() => parseGenerateSupplyChainArguments(arguments_), "SPDX_ARGUMENTS");
    }
  });

  await suite.test("projects validated lock identities and SHA512 integrity into the expected graph", () => {
    const manifest = manifestForCurrentRuntime();
    const lockfile = lockfileFor(manifest);
    assert.deepEqual(
      buildExpectedSpdxGraph(lockfile, manifest),
      validateExpectedSpdxGraph(readJsonFixture("expected-graph.json")),
    );

    const peerOptional = lockfileFor(manifest);
    peerOptional.packages["node_modules/alpha"].peerDependencies = { "@scope/beta": "2.0.0" };
    peerOptional.packages["node_modules/alpha"].peerDependenciesMeta = {
      "@scope/beta": { optional: true },
    };
    const peerGraph = buildExpectedSpdxGraph(peerOptional, manifest);
    assert.equal(
      peerGraph.relationships.find((relationship) => (
        relationship.spdxElementId === "SPDXRef-Package-scope.beta-2.0.0"
        && relationship.relatedSpdxElement === "SPDXRef-Package-alpha-1.2.3"
      )).relationshipType,
      "DEPENDENCY_OF",
    );

    const peerRequired = lockfileFor(manifest);
    peerRequired.packages["node_modules/alpha"].peerDependencies = { "@scope/beta": "2.0.0" };
    const requiredPeerGraph = buildExpectedSpdxGraph(peerRequired, manifest);
    assert.equal(
      requiredPeerGraph.relationships.find((relationship) => (
        relationship.spdxElementId === "SPDXRef-Package-scope.beta-2.0.0"
        && relationship.relatedSpdxElement === "SPDXRef-Package-alpha-1.2.3"
      )).relationshipType,
      "PREREQUISITE_FOR",
    );

    const precedence = clone(peerOptional);
    precedence.packages["node_modules/alpha"].dependencies = { "@scope/beta": "2.0.0" };
    precedence.packages["node_modules/alpha"].optionalDependencies = { "@scope/beta": "2.0.0" };
    const precedenceGraph = buildExpectedSpdxGraph(precedence, manifest);
    assert.equal(
      precedenceGraph.relationships.find((relationship) => (
        relationship.spdxElementId === "SPDXRef-Package-scope.beta-2.0.0"
        && relationship.relatedSpdxElement === "SPDXRef-Package-alpha-1.2.3"
      )).relationshipType,
      "OPTIONAL_DEPENDENCY_OF",
    );

    const missingRequired = lockfileFor(manifest);
    missingRequired.packages["node_modules/alpha"].dependencies = { missing: "1.0.0" };
    expectCode(() => buildExpectedSpdxGraph(missingRequired, manifest), "NPM_LOCK_DEPENDENCY_MISSING");

    const missingPeer = lockfileFor(manifest);
    missingPeer.packages["node_modules/alpha"].peerDependencies = { missing: "1.0.0" };
    expectCode(() => buildExpectedSpdxGraph(missingPeer, manifest), "NPM_LOCK_DEPENDENCY_MISSING");
  });

  await suite.test("publishes both files together and restores the previous directory on failure", () => {
    const outer = mkdtempSync("/tmp/axial-muse-e011-publish-");
    const artifactDirectory = join(outer, "supply-chain");
    try {
      const baseline = normalize(readJsonFixture("native-a.json"));
      const firstDirectory = join(outer, "first");
      expectCode(() => publishSpdxArtifacts({
        artifactDirectory: firstDirectory,
        result: baseline,
        expectedPrevious: null,
        afterActivate: () => {
          throw new Error("injected first publication failure");
        },
      }), "SPDX_ARTIFACT_PUBLISH");
      assert.equal(existsSync(firstDirectory), false);

      publishSpdxArtifacts({
        artifactDirectory,
        result: baseline,
        expectedPrevious: null,
      });
      const previous = {
        evidenceBytes: readFileSync(join(artifactDirectory, "dependency-evidence.json"), "utf8"),
        sbomBytes: readFileSync(join(artifactDirectory, "sbom.spdx.json"), "utf8"),
      };
      const changedDocument = readJsonFixture("native-a.json");
      changedDocument.packages.find((package_) => package_.name === "alpha").description = "Changed";
      const changed = normalize(changedDocument, { createdAt: "2026-07-20T10:11:12Z" });
      expectCode(() => publishSpdxArtifacts({
        artifactDirectory,
        result: changed,
        expectedPrevious: previous,
        afterActivate: () => {
          throw new Error("injected publication failure");
        },
      }), "SPDX_ARTIFACT_PUBLISH");
      assert.equal(
        readFileSync(join(artifactDirectory, "sbom.spdx.json"), "utf8"),
        baseline.bytes,
      );
      assert.equal(
        readFileSync(join(artifactDirectory, "dependency-evidence.json"), "utf8"),
        baseline.evidenceBytes,
      );
      expectCode(() => publishSpdxArtifacts({
        artifactDirectory,
        result: changed,
        expectedPrevious: previous,
        afterActivate: () => {
          writeFileSync(join(artifactDirectory, "sbom.spdx.json"), "tampered\n", "utf8");
        },
      }), "SPDX_ARTIFACT_CONCURRENT_CHANGE");
      assert.equal(
        readFileSync(join(artifactDirectory, "sbom.spdx.json"), "utf8"),
        baseline.bytes,
      );
      assert.equal(
        readFileSync(join(artifactDirectory, "dependency-evidence.json"), "utf8"),
        baseline.evidenceBytes,
      );

      const externalDirectory = join(outer, "external-case");
      publishSpdxArtifacts({
        artifactDirectory: externalDirectory,
        result: baseline,
        expectedPrevious: null,
      });
      expectCode(() => publishSpdxArtifacts({
        artifactDirectory: externalDirectory,
        result: changed,
        expectedPrevious: previous,
        afterBackup: () => {
          writeFileSync(
            join(outer, ".external-case.backup", "dependency-evidence.json"),
            "external writer\n",
            "utf8",
          );
        },
      }), "SPDX_ARTIFACT_PUBLISH_UNCERTAIN");
      assert.equal(existsSync(externalDirectory), false);
      assert.equal(
        readFileSync(join(outer, ".external-case.backup", "dependency-evidence.json"), "utf8"),
        "external writer\n",
      );
      assert.equal(
        readFileSync(join(outer, ".external-case.backup", "sbom.spdx.json"), "utf8"),
        baseline.bytes,
      );

      const lostDirectory = join(outer, "lost-case");
      publishSpdxArtifacts({
        artifactDirectory: lostDirectory,
        result: baseline,
        expectedPrevious: null,
      });
      expectCode(() => publishSpdxArtifacts({
        artifactDirectory: lostDirectory,
        result: changed,
        expectedPrevious: previous,
        afterActivate: () => {
          rmSync(join(outer, ".lost-case.backup"), { recursive: true, force: true });
          throw new Error("injected backup loss");
        },
      }), "SPDX_ARTIFACT_PUBLISH_UNCERTAIN");
      assert.equal(
        readFileSync(join(lostDirectory, "sbom.spdx.json"), "utf8"),
        changed.bytes,
      );

      const tamperDirectory = join(outer, "tamper-case");
      publishSpdxArtifacts({
        artifactDirectory: tamperDirectory,
        result: baseline,
        expectedPrevious: null,
      });
      expectCode(() => publishSpdxArtifacts({
        artifactDirectory: tamperDirectory,
        result: changed,
        expectedPrevious: previous,
        afterActivate: () => {
          writeFileSync(
            join(outer, ".tamper-case.backup", "sbom.spdx.json"),
            "tampered backup\n",
            "utf8",
          );
          throw new Error("injected backup tampering");
        },
      }), "SPDX_ARTIFACT_PUBLISH_UNCERTAIN");
      assert.equal(
        readFileSync(join(tamperDirectory, "sbom.spdx.json"), "utf8"),
        changed.bytes,
      );
      assert.equal(
        readFileSync(join(outer, ".tamper-case.backup", "sbom.spdx.json"), "utf8"),
        "tampered backup\n",
      );
      const entries = readdirSync(outer).sort();
      assert.equal(entries.includes(".external-case.backup"), true);
      assert.equal(entries.filter((entry) => entry.startsWith(".external-case.candidate-")).length, 1);
      assert.equal(entries.includes(".tamper-case.backup"), true);
      assert.equal(entries.includes("lost-case"), true);
      assert.equal(entries.includes("supply-chain"), true);
      assert.equal(entries.includes("tamper-case"), true);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  await suite.test("fsyncs candidate bytes and every successful publication transition", () => {
    const outer = mkdtempSync("/tmp/axial-muse-e011-sync-");
    const artifactDirectory = join(outer, "supply-chain");
    try {
      const baseline = normalize(readJsonFixture("native-a.json"));
      publishSpdxArtifacts({
        artifactDirectory,
        result: baseline,
        expectedPrevious: null,
      });
      const previous = {
        evidenceBytes: baseline.evidenceBytes,
        sbomBytes: baseline.bytes,
      };
      const changedDocument = readJsonFixture("native-a.json");
      changedDocument.packages.find((package_) => package_.name === "alpha").description = "Changed";
      const changed = normalize(changedDocument, { createdAt: "2026-07-20T10:11:12Z" });
      const phases = [];
      publishSpdxArtifacts({
        artifactDirectory,
        result: changed,
        expectedPrevious: previous,
        syncFile: () => phases.push("file-sync"),
        syncCandidateDirectory: (path) => {
          assert.equal(path.startsWith(`${outer}/.supply-chain.candidate-`), true);
          phases.push("candidate-sync");
        },
        syncParentDirectory: (path) => {
          assert.equal(path, outer);
          phases.push("sync");
        },
        afterBackup: () => phases.push("backup-checked"),
        afterActivate: () => phases.push("active-checked"),
      });
      assert.deepEqual(phases, [
        "file-sync",
        "file-sync",
        "candidate-sync",
        "sync",
        "backup-checked",
        "sync",
        "active-checked",
        "sync",
      ]);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  await suite.test("integrates two E-010 sbom-native workspaces before atomic publication", () => {
    const fixture = createIntegrationFixture();
    const calls = [];
    let workloadIndex = 0;
    const nativeDocuments = [
      nativeForRuntime("native-a.json", fixture.actualNpmVersion),
      nativeForRuntime("native-b.json", fixture.actualNpmVersion),
    ];
    const runProcess = (_executable, arguments_, options) => {
      calls.push({
        arguments: clone(arguments_),
        cache: options.env.NPM_CONFIG_CACHE,
        globalconfig: options.env.NPM_CONFIG_GLOBALCONFIG,
        home: options.env.HOME,
        logs: options.env.NPM_CONFIG_LOGS_DIR,
        userconfig: options.env.NPM_CONFIG_USERCONFIG,
      });
      if (arguments_.slice(-3).join(" ") === "config list --json") {
        return {
          status: 0,
          signal: null,
          stdout: `${JSON.stringify(effectiveConfig(options.env))}\n`,
          stderr: "",
        };
      }
      const stdout = `${JSON.stringify(nativeDocuments[workloadIndex])}\n`;
      workloadIndex += 1;
      return { status: 0, signal: null, stdout, stderr: "" };
    };
    try {
      const result = withWorkingDirectory(fixture.root, () => generateSupplyChainArtifacts({
        root: fixture.root,
        artifactDirectory: fixture.artifactDirectory,
        createdAt: CREATED_AT,
        runProcess,
        temporaryParent: fixture.outer,
        npmVersionsByRole: fixture.npmVersionsByRole,
      }));
      assert.equal(workloadIndex, 2);
      const workloadCalls = calls.filter((call) => call.arguments.includes("sbom"));
      assert.equal(workloadCalls.length, 2);
      for (const call of workloadCalls) {
        assert.deepEqual(call.arguments.slice(-5), [
          "sbom",
          "--package-lock-only",
          "--sbom-format=spdx",
          "--sbom-type=application",
          "--offline",
        ]);
        assert.equal(existsSync(call.home), false);
        assert.equal(existsSync(call.cache), false);
      }
      assert.notEqual(workloadCalls[0].home, workloadCalls[1].home);
      assert.notEqual(workloadCalls[0].cache, workloadCalls[1].cache);
      assert.notEqual(workloadCalls[0].userconfig, workloadCalls[1].userconfig);
      assert.notEqual(workloadCalls[0].globalconfig, workloadCalls[1].globalconfig);
      assert.notEqual(workloadCalls[0].logs, workloadCalls[1].logs);
      assert.equal(
        readFileSync(join(fixture.artifactDirectory, "sbom.spdx.json"), "utf8"),
        result.bytes,
      );
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("consumes the bundled npm native SPDX offline through E-010", () => {
    const fixture = createIntegrationFixture();
    try {
      const result = withWorkingDirectory(fixture.root, () => generateSupplyChainArtifacts({
        root: fixture.root,
        artifactDirectory: fixture.artifactDirectory,
        createdAt: CREATED_AT,
        temporaryParent: fixture.outer,
        npmVersionsByRole: fixture.npmVersionsByRole,
      }));
      assert.equal(
        readFileSync(join(fixture.artifactDirectory, "sbom.spdx.json"), "utf8"),
        result.bytes,
      );
      assert.equal(result.sbomEvidence.createdAt, CREATED_AT);
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("rejects divergent native runs and non-primary runtime results", () => {
    const divergentFixture = createIntegrationFixture();
    try {
      const second = nativeForRuntime("native-b.json", divergentFixture.actualNpmVersion);
      second.packages.find((package_) => package_.name === "alpha").description = "Divergent";
      const divergent = createNativeProcess([
        nativeForRuntime("native-a.json", divergentFixture.actualNpmVersion),
        second,
      ]);
      expectCode(() => withWorkingDirectory(divergentFixture.root, () => (
        generateSupplyChainArtifacts({
          root: divergentFixture.root,
          artifactDirectory: divergentFixture.artifactDirectory,
          createdAt: CREATED_AT,
          runProcess: divergent.runProcess,
          temporaryParent: divergentFixture.outer,
          npmVersionsByRole: divergentFixture.npmVersionsByRole,
        })
      )), "SPDX_DETERMINISM_MISMATCH");
      assert.equal(divergent.workloadCount, 2);
      assert.equal(existsSync(divergentFixture.artifactDirectory), false);
    } finally {
      rmSync(divergentFixture.outer, { recursive: true, force: true });
    }

    const roleFixture = createIntegrationFixture();
    try {
      const processState = createNativeProcess([
        nativeForRuntime("native-a.json", roleFixture.actualNpmVersion),
      ]);
      const wrongRole = (options) => {
        const result = runIsolatedNpm(options);
        return { ...result, runtime: { ...result.runtime, role: "minimum" } };
      };
      expectCode(() => withWorkingDirectory(roleFixture.root, () => (
        generateSupplyChainArtifacts({
          root: roleFixture.root,
          artifactDirectory: roleFixture.artifactDirectory,
          createdAt: CREATED_AT,
          runProcess: processState.runProcess,
          runIsolated: wrongRole,
          temporaryParent: roleFixture.outer,
          npmVersionsByRole: roleFixture.npmVersionsByRole,
        })
      )), "SPDX_PRIMARY_ONLY");
      assert.equal(existsSync(roleFixture.artifactDirectory), false);
    } finally {
      rmSync(roleFixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("reuses valid existing artifacts and rejects tampering before native work", () => {
    const fixture = createIntegrationFixture();
    try {
      const firstProcess = createNativeProcess([
        nativeForRuntime("native-a.json", fixture.actualNpmVersion),
        nativeForRuntime("native-b.json", fixture.actualNpmVersion),
      ]);
      const first = withWorkingDirectory(fixture.root, () => generateSupplyChainArtifacts({
        root: fixture.root,
        artifactDirectory: fixture.artifactDirectory,
        createdAt: CREATED_AT,
        runProcess: firstProcess.runProcess,
        temporaryParent: fixture.outer,
        npmVersionsByRole: fixture.npmVersionsByRole,
      }));
      const reusedProcess = createNativeProcess([
        nativeForRuntime("native-b.json", fixture.actualNpmVersion),
        nativeForRuntime("native-a.json", fixture.actualNpmVersion),
      ]);
      const reused = withWorkingDirectory(fixture.root, () => generateSupplyChainArtifacts({
        root: fixture.root,
        artifactDirectory: fixture.artifactDirectory,
        runProcess: reusedProcess.runProcess,
        temporaryParent: fixture.outer,
        npmVersionsByRole: fixture.npmVersionsByRole,
      }));
      assert.equal(reused.bytes, first.bytes);
      assert.equal(reused.evidenceBytes, first.evidenceBytes);

      const evidencePath = join(fixture.artifactDirectory, "dependency-evidence.json");
      const tampered = JSON.parse(readFileSync(evidencePath, "utf8"));
      tampered.sbom.semanticSha256 = "0".repeat(64);
      writeJson(evidencePath, tampered);
      const tamperedBytes = readFileSync(evidencePath, "utf8");
      const blockedProcess = createNativeProcess([]);
      expectCode(() => withWorkingDirectory(fixture.root, () => generateSupplyChainArtifacts({
        root: fixture.root,
        artifactDirectory: fixture.artifactDirectory,
        runProcess: blockedProcess.runProcess,
        temporaryParent: fixture.outer,
        npmVersionsByRole: fixture.npmVersionsByRole,
      })), "SPDX_SEMANTIC_MISMATCH");
      assert.equal(blockedProcess.workloadCount, 0);
      assert.equal(readFileSync(evidencePath, "utf8"), tamperedBytes);
      assert.equal(
        readFileSync(join(fixture.artifactDirectory, "sbom.spdx.json"), "utf8"),
        first.bytes,
      );
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("moves from graph A to graph B only with a new explicit createdAt", () => {
    const fixture = createIntegrationFixture();
    try {
      const initialProcess = createNativeProcess([
        nativeForRuntime("native-a.json", fixture.actualNpmVersion),
        nativeForRuntime("native-b.json", fixture.actualNpmVersion),
      ]);
      const initial = withWorkingDirectory(fixture.root, () => generateSupplyChainArtifacts({
        root: fixture.root,
        artifactDirectory: fixture.artifactDirectory,
        createdAt: CREATED_AT,
        runProcess: initialProcess.runProcess,
        temporaryParent: fixture.outer,
        npmVersionsByRole: fixture.npmVersionsByRole,
      }));

      const nextLock = lockfileFor(fixture.manifest);
      nextLock.packages["node_modules/alpha"].integrity = `sha512-${Buffer.alloc(64, 0xcc).toString("base64")}`;
      writeJson(join(fixture.root, "package-lock.json"), nextLock);
      const changedDocuments = ["native-a.json", "native-b.json"].map((name) => {
        const document = nativeForRuntime(name, fixture.actualNpmVersion);
        document.packages.find((package_) => package_.name === "alpha")
          .checksums[0].checksumValue = "c".repeat(128);
        return document;
      });
      const missingTimeProcess = createNativeProcess(changedDocuments);
      expectCode(() => withWorkingDirectory(fixture.root, () => generateSupplyChainArtifacts({
        root: fixture.root,
        artifactDirectory: fixture.artifactDirectory,
        runProcess: missingTimeProcess.runProcess,
        temporaryParent: fixture.outer,
        npmVersionsByRole: fixture.npmVersionsByRole,
      })), "SPDX_CREATED_AT_REQUIRED");
      assert.equal(
        readFileSync(join(fixture.artifactDirectory, "sbom.spdx.json"), "utf8"),
        initial.bytes,
      );

      const acceptedProcess = createNativeProcess(changedDocuments);
      const accepted = withWorkingDirectory(fixture.root, () => generateSupplyChainArtifacts({
        root: fixture.root,
        artifactDirectory: fixture.artifactDirectory,
        createdAt: "2026-07-20T10:11:12Z",
        runProcess: acceptedProcess.runProcess,
        temporaryParent: fixture.outer,
        npmVersionsByRole: fixture.npmVersionsByRole,
      }));
      assert.notEqual(accepted.sbomEvidence.semanticSha256, initial.sbomEvidence.semanticSha256);
      assert.equal(accepted.sbomEvidence.createdAt, "2026-07-20T10:11:12Z");
      assert.equal(
        readFileSync(join(fixture.artifactDirectory, "sbom.spdx.json"), "utf8"),
        accepted.bytes,
      );
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("blocks hostile effective config before native SPDX and leaves no artifact", () => {
    const fixture = createIntegrationFixture();
    let workloadCalls = 0;
    const runProcess = (_executable, arguments_, options) => {
      if (arguments_.slice(-3).join(" ") === "config list --json") {
        return {
          status: 0,
          signal: null,
          stdout: `${JSON.stringify(effectiveConfig(options.env, {
            registry: "https://registry.example.test/",
          }))}\n`,
          stderr: "",
        };
      }
      workloadCalls += 1;
      return { status: 0, signal: null, stdout: "{}\n", stderr: "" };
    };
    try {
      expectCode(() => withWorkingDirectory(fixture.root, () => generateSupplyChainArtifacts({
        root: fixture.root,
        artifactDirectory: fixture.artifactDirectory,
        createdAt: CREATED_AT,
        runProcess,
        temporaryParent: fixture.outer,
        npmVersionsByRole: fixture.npmVersionsByRole,
      })), "NPM_EFFECTIVE_CONFIG_VALUE");
      assert.equal(workloadCalls, 0);
      assert.equal(existsSync(fixture.artifactDirectory), false);
      assert.equal(
        readdirSync(join(fixture.outer, "artifacts")).some((entry) => entry.includes("lock")),
        false,
      );
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("serializes generators before any native npm child", () => {
    const fixture = createIntegrationFixture();
    const artifactParent = resolve(fixture.artifactDirectory, "..");
    mkdirSync(artifactParent, { recursive: true });
    const lockPath = join(artifactParent, ".supply-chain.generation.lock");
    writeFileSync(lockPath, "held by first generator\n", "utf8");
    const processState = createNativeProcess([]);
    try {
      expectCode(() => withWorkingDirectory(fixture.root, () => generateSupplyChainArtifacts({
        root: fixture.root,
        artifactDirectory: fixture.artifactDirectory,
        createdAt: CREATED_AT,
        runProcess: processState.runProcess,
        temporaryParent: fixture.outer,
        npmVersionsByRole: fixture.npmVersionsByRole,
      })), "SPDX_GENERATION_LOCKED");
      assert.equal(processState.workloadCount, 0);
      assert.equal(readFileSync(lockPath, "utf8"), "held by first generator\n");
      assert.equal(existsSync(fixture.artifactDirectory), false);
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("does not publish when a generation input changes after the final native run", () => {
    const fixture = createIntegrationFixture();
    let workloadIndex = 0;
    const nativeDocuments = [
      nativeForRuntime("native-a.json", fixture.actualNpmVersion),
      nativeForRuntime("native-b.json", fixture.actualNpmVersion),
    ];
    const runProcess = (_executable, arguments_, options) => {
      if (arguments_.slice(-3).join(" ") === "config list --json") {
        return {
          status: 0,
          signal: null,
          stdout: `${JSON.stringify(effectiveConfig(options.env))}\n`,
          stderr: "",
        };
      }
      const stdout = `${JSON.stringify(nativeDocuments[workloadIndex])}\n`;
      workloadIndex += 1;
      return { status: 0, signal: null, stdout, stderr: "" };
    };
    let isolatedRuns = 0;
    const runIsolated = (options) => {
      const result = runIsolatedNpm(options);
      isolatedRuns += 1;
      if (isolatedRuns === 2) {
        writeFileSync(
          join(fixture.root, "package-lock.json"),
          `${readFileSync(join(fixture.root, "package-lock.json"), "utf8")}\n`,
          "utf8",
        );
      }
      return result;
    };
    try {
      expectCode(() => withWorkingDirectory(fixture.root, () => generateSupplyChainArtifacts({
        root: fixture.root,
        artifactDirectory: fixture.artifactDirectory,
        createdAt: CREATED_AT,
        runProcess,
        runIsolated,
        temporaryParent: fixture.outer,
        npmVersionsByRole: fixture.npmVersionsByRole,
      })), "SPDX_INPUT_CONCURRENT_CHANGE");
      assert.equal(isolatedRuns, 2);
      assert.equal(existsSync(fixture.artifactDirectory), false);
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });

  await suite.test("rolls back when an input changes after artifact activation", () => {
    const fixture = createIntegrationFixture();
    const processState = createNativeProcess([
      nativeForRuntime("native-a.json", fixture.actualNpmVersion),
      nativeForRuntime("native-b.json", fixture.actualNpmVersion),
    ]);
    try {
      expectCode(() => withWorkingDirectory(fixture.root, () => generateSupplyChainArtifacts({
        root: fixture.root,
        artifactDirectory: fixture.artifactDirectory,
        createdAt: CREATED_AT,
        runProcess: processState.runProcess,
        temporaryParent: fixture.outer,
        npmVersionsByRole: fixture.npmVersionsByRole,
        afterActivate: () => {
          writeFileSync(
            join(fixture.root, "package-lock.json"),
            `${readFileSync(join(fixture.root, "package-lock.json"), "utf8")}\n`,
            "utf8",
          );
        },
      })), "SPDX_INPUT_CONCURRENT_CHANGE");
      assert.equal(processState.workloadCount, 2);
      assert.equal(existsSync(fixture.artifactDirectory), false);
    } finally {
      rmSync(fixture.outer, { recursive: true, force: true });
    }
  });
});

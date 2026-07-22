import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  parseCandidateReviewArguments,
  reviewSupplyChainCandidates,
} from "../../scripts/quality/lib/supply-chain/candidate-review.mjs";
import { PROJECT_NPM_CONFIG } from "../../scripts/quality/lib/supply-chain/contracts.mjs";
import { deriveNpmCli } from "../../scripts/quality/lib/supply-chain/environment.mjs";
import { NpmIsolationError } from "../../scripts/quality/lib/supply-chain/errors.mjs";
import {
  readAndVerifyRestrictedSupplyChainInputReceipt,
  SUPPLY_CHAIN_INPUT_PATHS,
  supplyChainInputReceiptBytes,
  supplyChainInputReceiptSha256,
} from "../../scripts/quality/lib/supply-chain/input-receipt.mjs";
import { EXPECTED_DEPENDENCY_POLICY } from "../../scripts/quality/lib/supply-chain/policy.mjs";
import { canonicalJsonBytes } from "../../scripts/quality/lib/supply-chain/spdx.mjs";
import { main as reviewMain } from "../../scripts/quality/review-supply-chain-candidates.mjs";
import { emptyDependencyLicenseEvidence } from "./supply-chain-license-evidence-fixture.mjs";

function clone(value) {
  return structuredClone(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function npmrcText() {
  return `${Object.entries(PROJECT_NPM_CONFIG)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function packageParts(identity) {
  const separator = identity.lastIndexOf("@");
  return {
    name: identity.slice(0, separator),
    version: identity.slice(separator + 1),
  };
}

function lockedEntry(identity, digestByte) {
  const { name, version } = packageParts(identity);
  const tarName = name.includes("/") ? name.split("/")[1] : name;
  return {
    identity,
    name,
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${tarName}-${version}.tgz`,
    integrity: `sha512-${Buffer.alloc(64, digestByte).toString("base64")}`,
    hasInstallScript: false,
    paths: [`node_modules/${name}`],
  };
}

function legalFile(text) {
  const bytes = Buffer.from(text, "utf8");
  return {
    path: "package/LICENSE",
    rawSha256: sha256(bytes),
    size: bytes.length,
    text,
  };
}

function inspectionFor(locked, { licenseText = "Synthetic license text.\n" } = {}) {
  const scripts = {};
  return {
    actualHasInstallScript: false,
    bindingGyp: false,
    description: `Synthetic fixture for ${locked.identity}.`,
    effectiveInstallScripts: {},
    entryCount: 2,
    gypfile: null,
    homepage: `https://example.test/${encodeURIComponent(locked.identity)}`,
    identity: locked.identity,
    implicitNodeGyp: false,
    integrity: locked.integrity,
    integritySha512: Buffer.from(
      locked.integrity.slice("sha512-".length),
      "base64",
    ).toString("hex"),
    licenseDeclared: "MIT",
    licenseFiles: [legalFile(licenseText)],
    noticeFiles: [],
    packageJsonSha256: sha256(`package:${locked.identity}`),
    scripts,
    scriptsSha256: sha256(`${JSON.stringify(scripts, null, 2)}\n`),
  };
}

function createFixture({ identities = ["alpha@1.0.0"] } = {}) {
  const outer = mkdtempSync("/tmp/axial-muse-candidate-review-test-");
  const root = join(outer, "project");
  const temporaryParent = join(outer, "reports");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(temporaryParent, { mode: 0o700 });
  mkdirSync(join(root, "docs", "contracts"), { recursive: true });

  const dependencies = Object.fromEntries(identities.map((identity) => {
    const { name, version } = packageParts(identity);
    return [name, version];
  }));
  const manifest = {
    name: "candidate-review-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies,
    engines: {
      node: `>=${process.versions.node} <${Number(process.versions.node.split(".")[0]) + 1}`,
    },
  };
  const lockedPackages = identities.map((identity, index) => (
    lockedEntry(identity, 0x20 + index)
  ));
  const packages = {
    "": {
      name: manifest.name,
      version: manifest.version,
      dependencies: clone(dependencies),
    },
  };
  for (const locked of lockedPackages) {
    packages[locked.paths[0]] = {
      version: locked.version,
      resolved: locked.resolved,
      integrity: locked.integrity,
    };
  }
  const lockfile = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages,
  };

  writeJson(join(root, "package.json"), manifest);
  writeJson(join(root, "package-lock.json"), lockfile);
  writeFileSync(join(root, ".npmrc"), npmrcText(), "utf8");
  writeFileSync(join(root, ".nvmrc"), `${process.versions.node}\n`, "utf8");
  writeFileSync(
    join(root, "docs", "contracts", "dependency-policy.json"),
    canonicalJsonBytes(EXPECTED_DEPENDENCY_POLICY),
    "utf8",
  );
  writeFileSync(
    join(root, "docs", "contracts", "dependency-license-evidence.json"),
    canonicalJsonBytes(emptyDependencyLicenseEvidence()),
    "utf8",
  );
  // 预准入入口必须完全忽略这个尚未形成最终结论的文件。
  writeFileSync(
    join(root, "docs", "contracts", "dependency-admissions.json"),
    "this is deliberately not JSON\n",
    "utf8",
  );

  const npmVersion = deriveNpmCli(process.execPath).npmVersion;
  return {
    inspections: lockedPackages.map((locked) => inspectionFor(locked)),
    lockedPackages,
    npmVersionsByRole: {
      minimum: "0.0.0",
      primary: npmVersion,
    },
    outer,
    root,
    temporaryParent,
  };
}

function cleanupFixture(fixture) {
  rmSync(fixture.outer, { force: true, recursive: true });
}

function controlledReview(fixture, {
  afterDownload = null,
  afterReview = null,
  beforeDownload = null,
  betweenPackages = null,
  inspections = fixture.inspections,
} = {}) {
  let downloadIndex = 0;
  return {
    download: async (lockedPackage) => {
      if (beforeDownload) beforeDownload({ downloadIndex, lockedPackage });
      const bytes = Buffer.from(`synthetic tarball ${lockedPackage.identity}`, "utf8");
      if (afterDownload) afterDownload({ downloadIndex, lockedPackage });
      downloadIndex += 1;
      return bytes;
    },
    reviewTarballs: async ({ download, lockedPackages, validateInspection }) => {
      assert.equal(typeof validateInspection, "function");
      const inspectionsByIdentity = new Map(
        inspections.map((inspection) => [inspection.identity, inspection]),
      );
      for (const [index, lockedPackage] of lockedPackages.entries()) {
        if (index > 0 && betweenPackages) betweenPackages({ index, lockedPackage });
        const bytes = await download(lockedPackage);
        bytes.fill(0);
        const inspection = inspectionsByIdentity.get(lockedPackage.identity);
        if (inspection !== undefined) {
          validateInspection({ inspection, lockedPackage });
        }
      }
      if (afterReview) afterReview();
      return clone(inspections);
    },
  };
}

async function runFixture(fixture, overrides = {}) {
  return reviewSupplyChainCandidates({
    root: fixture.root,
    temporaryParent: fixture.temporaryParent,
    npmVersionsByRole: fixture.npmVersionsByRole,
    ...controlledReview(fixture),
    ...overrides,
  });
}

async function expectCode(action, code) {
  await assert.rejects(
    action,
    (error) => error instanceof NpmIsolationError && error.code === code,
  );
}

function captureStream() {
  let output = "";
  return {
    stream: {
      write(chunk) {
        output += String(chunk);
        return true;
      },
    },
    value() {
      return output;
    },
  };
}

function syncDirectoryForTest(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function findNestedFiles(root, name) {
  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) matches.push(...findNestedFiles(path, name));
    else if (entry.isFile() && entry.name === name) matches.push(path);
  }
  return matches;
}

test("D-077 restricted candidate review orchestration", async (suite) => {
  await suite.test("validates the closed graph and publishes only a private fsynced report", async () => {
    const fixture = createFixture({ identities: ["zeta@2.0.0", "@scope/alpha@1.0.0"] });
    let result;
    try {
      const calls = [];
      const syncedDirectories = [];
      const controlled = controlledReview(fixture);
      result = await runFixture(fixture, {
        download: async (lockedPackage) => {
          assert.equal(syncedDirectories.length, 2);
          assert.equal(syncedDirectories[0].startsWith(`${fixture.temporaryParent}/`), true);
          assert.equal(syncedDirectories[1], fixture.temporaryParent);
          calls.push(lockedPackage.identity);
          return controlled.download(lockedPackage);
        },
        reviewTarballs: controlled.reviewTarballs,
        syncDirectoryPath: (path) => {
          syncDirectoryForTest(path);
          syncedDirectories.push(path);
        },
      });

      assert.equal(result.packageCount, 2);
      assert.equal(dirname(result.reportPath).startsWith(`${fixture.temporaryParent}/`), true);
      assert.equal(lstatSync(dirname(result.reportPath)).mode & 0o777, 0o700);
      assert.equal(lstatSync(result.reportPath).mode & 0o777, 0o600);
      assert.equal(dirname(result.receiptPath), dirname(result.reportPath));
      assert.equal(lstatSync(result.receiptPath).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(dirname(result.reportPath)).sort(), [
        "receipt.json",
        "report.json",
      ]);
      assert.deepEqual(syncedDirectories, [
        dirname(result.reportPath),
        fixture.temporaryParent,
        dirname(result.reportPath),
        fixture.temporaryParent,
      ]);
      assert.deepEqual(calls, ["@scope/alpha@1.0.0", "zeta@2.0.0"]);
      const report = JSON.parse(readFileSync(result.reportPath, "utf8"));
      assert.equal(report.kind, "axial_muse_supply_chain_review_report");
      assert.equal(report.status, "candidate");
      assert.deepEqual(report.receipt.runtime, {
        nodeVersion: process.versions.node,
        npmVersion: fixture.npmVersionsByRole.primary,
        role: "primary",
      });
      assert.deepEqual(report.receipt.inputs, Object.fromEntries(
        SUPPLY_CHAIN_INPUT_PATHS.map((relativePath) => [
          relativePath,
          sha256(readFileSync(join(fixture.root, relativePath), "utf8")),
        ]),
      ));
      assert.equal(result.receiptSha256, supplyChainInputReceiptSha256(report.receipt));
      assert.equal(
        readFileSync(result.receiptPath, "utf8"),
        supplyChainInputReceiptBytes(report.receipt),
      );
      const verifiedReceipt = readAndVerifyRestrictedSupplyChainInputReceipt({
        npmVersionsByRole: fixture.npmVersionsByRole,
        path: result.receiptPath,
        root: fixture.root,
      });
      assert.deepEqual(verifiedReceipt.receipt, report.receipt);
      assert.equal(verifiedReceipt.receiptSha256, result.receiptSha256);
      assert.deepEqual(report.packages.map(({ identity }) => identity), [
        "@scope/alpha@1.0.0",
        "zeta@2.0.0",
      ]);
      assert.equal(readFileSync(result.reportPath, "utf8").endsWith("\n"), true);
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("forwards task-private download options through the input-drift guard", async () => {
    const fixture = createFixture();
    const downloadOptions = Object.freeze({ agent: Object.freeze({ task: "candidate" }) });
    const forwarded = [];
    try {
      const controlled = controlledReview(fixture);
      await runFixture(fixture, {
        download: async (lockedPackage, actualOptions) => {
          forwarded.push(actualOptions);
          return controlled.download(lockedPackage);
        },
        reviewTarballs: async ({ download, lockedPackages }) => {
          for (const lockedPackage of lockedPackages) {
            const bytes = await download(lockedPackage, downloadOptions);
            bytes.fill(0);
          }
          return clone(fixture.inspections);
        },
      });
      assert.deepEqual(forwarded, [downloadOptions]);
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("fails closed on review closure and removes the whole failed report directory", async () => {
    const fixture = createFixture();
    try {
      await expectCode(
        () => runFixture(fixture, controlledReview(fixture, { inspections: [] })),
        "SUPPLY_CHAIN_REVIEW_CLOSURE",
      );
      assert.deepEqual(readdirSync(fixture.temporaryParent), []);
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("removes a written report when the final parent-directory sync fails", async () => {
    const fixture = createFixture();
    let syncCalls = 0;
    try {
      await expectCode(
        () => runFixture(fixture, {
          syncDirectoryPath: (path) => {
            syncDirectoryForTest(path);
            syncCalls += 1;
            if (syncCalls === 4) {
              throw new NpmIsolationError(
                "SUPPLY_CHAIN_REVIEW_REPORT_SYNC",
                "synthetic private report marker",
              );
            }
          },
        }),
        "SUPPLY_CHAIN_REVIEW_REPORT_SYNC",
      );
      assert.equal(syncCalls, 6);
      assert.deepEqual(readdirSync(fixture.temporaryParent), []);
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("does not adopt or delete a same-byte report replacement in the success window", async () => {
    const fixture = createFixture();
    let syncCalls = 0;
    let replacementIdentity = null;
    let replacementBytes = null;
    try {
      await expectCode(
        () => runFixture(fixture, {
          syncDirectoryPath: (path) => {
            syncDirectoryForTest(path);
            syncCalls += 1;
            if (syncCalls === 4) {
              const [directoryName] = readdirSync(fixture.temporaryParent);
              const reportPath = join(fixture.temporaryParent, directoryName, "report.json");
              replacementBytes = readFileSync(reportPath);
              unlinkSync(reportPath);
              writeFileSync(reportPath, replacementBytes, { mode: 0o600 });
              const stat = lstatSync(reportPath);
              replacementIdentity = { dev: stat.dev, ino: stat.ino };
            }
          },
        }),
        "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
      );
      assert.notEqual(replacementIdentity, null);
      const retained = findNestedFiles(fixture.temporaryParent, "report.json");
      assert.equal(retained.length, 1);
      const retainedStat = lstatSync(retained[0]);
      assert.deepEqual(
        { dev: retainedStat.dev, ino: retainedStat.ino },
        replacementIdentity,
      );
      assert.deepEqual(readFileSync(retained[0]), replacementBytes);
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("does not adopt or delete a same-byte receipt replacement", async () => {
    const fixture = createFixture();
    let syncCalls = 0;
    let replacementIdentity = null;
    let replacementBytes = null;
    try {
      await expectCode(
        () => runFixture(fixture, {
          syncDirectoryPath: (path) => {
            syncDirectoryForTest(path);
            syncCalls += 1;
            if (syncCalls === 4) {
              const [directoryName] = readdirSync(fixture.temporaryParent);
              const receiptPath = join(fixture.temporaryParent, directoryName, "receipt.json");
              replacementBytes = readFileSync(receiptPath);
              unlinkSync(receiptPath);
              writeFileSync(receiptPath, replacementBytes, { mode: 0o600 });
              const stat = lstatSync(receiptPath);
              replacementIdentity = { dev: stat.dev, ino: stat.ino };
            }
          },
        }),
        "SUPPLY_CHAIN_REVIEW_CLEANUP_UNCERTAIN",
      );
      assert.notEqual(replacementIdentity, null);
      const retainedReceipts = findNestedFiles(fixture.temporaryParent, "receipt.json");
      assert.equal(retainedReceipts.length, 1);
      const retainedStat = lstatSync(retainedReceipts[0]);
      assert.deepEqual(
        { dev: retainedStat.dev, ino: retainedStat.ino },
        replacementIdentity,
      );
      assert.deepEqual(readFileSync(retainedReceipts[0]), replacementBytes);
      assert.equal(findNestedFiles(fixture.temporaryParent, "report.json").length, 1);
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("persists cleanup when initial review-directory sync fails", async () => {
    const fixture = createFixture();
    const syncedPaths = [];
    try {
      await expectCode(
        () => runFixture(fixture, {
          syncDirectoryPath: (path) => {
            syncDirectoryForTest(path);
            syncedPaths.push(path);
            if (syncedPaths.length === 1) {
              throw new Error("synthetic initial directory sync failure");
            }
          },
        }),
        "SUPPLY_CHAIN_REVIEW_TEMP_CREATE",
      );
      assert.equal(syncedPaths[0].startsWith(`${fixture.temporaryParent}/`), true);
      assert.equal(syncedPaths[1], fixture.temporaryParent);
      assert.deepEqual(readdirSync(fixture.temporaryParent), []);
    } finally {
      cleanupFixture(fixture);
    }
  });

  await suite.test("validates npmrc, runtime, manifest, sole lock and policy before the first download", async () => {
    const cases = [
      {
        code: "NPM_CONFIG_VALUE",
        mutate(fixture) {
          writeFileSync(
            join(fixture.root, ".npmrc"),
            npmrcText().replace(
              "registry=https://registry.npmjs.org/",
              "registry=https://registry.example.test/",
            ),
            "utf8",
          );
        },
      },
      {
        code: "NPM_RUNTIME_CONTRACT",
        mutate(fixture) {
          writeFileSync(join(fixture.root, ".nvmrc"), "0.0.0\n", "utf8");
        },
      },
      {
        code: "NPM_MANIFEST_SOURCE",
        mutate(fixture) {
          const path = join(fixture.root, "package.json");
          const manifest = JSON.parse(readFileSync(path, "utf8"));
          manifest.dependencies.alpha = "file:../alpha";
          writeJson(path, manifest);
        },
      },
      {
        code: "NPM_LOCK_MANIFEST_DRIFT",
        mutate(fixture) {
          const path = join(fixture.root, "package-lock.json");
          const lockfile = JSON.parse(readFileSync(path, "utf8"));
          lockfile.packages[""].dependencies.alpha = "2.0.0";
          writeJson(path, lockfile);
        },
      },
      {
        code: "NPM_LOCK_COMPETING",
        mutate(fixture) {
          writeFileSync(join(fixture.root, "yarn.lock"), "synthetic\n", "utf8");
        },
      },
      {
        code: "SUPPLY_CHAIN_POLICY_DRIFT",
        mutate(fixture) {
          const policy = clone(EXPECTED_DEPENDENCY_POLICY);
          policy.status = "candidate";
          writeFileSync(
            join(fixture.root, "docs", "contracts", "dependency-policy.json"),
            canonicalJsonBytes(policy),
            "utf8",
          );
        },
      },
    ];

    for (const case_ of cases) {
      const fixture = createFixture();
      let downloads = 0;
      try {
        case_.mutate(fixture);
        await expectCode(
          () => runFixture(fixture, {
            download: async () => {
              downloads += 1;
              return Buffer.from("must not happen", "utf8");
            },
          }),
          case_.code,
        );
        assert.equal(downloads, 0);
        assert.deepEqual(readdirSync(fixture.temporaryParent), []);
      } finally {
        cleanupFixture(fixture);
      }
    }
  });

  await suite.test("rechecks every fixed input after a package download and cleans failure state", async () => {
    const inputPaths = [
      ".npmrc",
      ".nvmrc",
      "package.json",
      "package-lock.json",
      "docs/contracts/dependency-license-evidence.json",
      "docs/contracts/dependency-policy.json",
    ];
    for (const relativePath of inputPaths) {
      const fixture = createFixture();
      try {
        const path = join(fixture.root, relativePath);
        await expectCode(
          () => runFixture(fixture, controlledReview(fixture, {
            afterDownload: () => writeFileSync(
              path,
              `${readFileSync(path, "utf8")} `,
              "utf8",
            ),
          })),
          "SUPPLY_CHAIN_REVIEW_INPUT_DRIFT",
        );
        assert.deepEqual(readdirSync(fixture.temporaryParent), []);
      } finally {
        cleanupFixture(fixture);
      }
    }
  });

  await suite.test("checks the boundary before each package and after the complete review", async () => {
    const betweenPackages = createFixture({ identities: ["alpha@1.0.0", "beta@1.0.0"] });
    try {
      await expectCode(
        () => runFixture(betweenPackages, controlledReview(betweenPackages, {
          betweenPackages: () => {
            const path = join(betweenPackages.root, ".nvmrc");
            writeFileSync(path, `${readFileSync(path, "utf8")} `, "utf8");
          },
        })),
        "SUPPLY_CHAIN_REVIEW_INPUT_DRIFT",
      );
      assert.deepEqual(readdirSync(betweenPackages.temporaryParent), []);
    } finally {
      cleanupFixture(betweenPackages);
    }

    const afterComplete = createFixture();
    try {
      await expectCode(
        () => runFixture(afterComplete, controlledReview(afterComplete, {
          afterReview: () => {
            const path = join(afterComplete.root, "package-lock.json");
            writeFileSync(path, `${readFileSync(path, "utf8")} `, "utf8");
          },
        })),
        "SUPPLY_CHAIN_REVIEW_INPUT_DRIFT",
      );
      assert.deepEqual(readdirSync(afterComplete.temporaryParent), []);
    } finally {
      cleanupFixture(afterComplete);
    }
  });

  await suite.test("rejects all root/output/force and positional arguments without echoing them", () => {
    assert.deepEqual(parseCandidateReviewArguments([]), {});
    for (const arguments_ of [
      ["--root", "/tmp/project"],
      ["--output", "/tmp/report.json"],
      ["--force"],
      ["candidate.json"],
    ]) {
      assert.throws(
        () => parseCandidateReviewArguments(arguments_),
        (error) => (
          error instanceof NpmIsolationError
          && error.code === "SUPPLY_CHAIN_REVIEW_ARGUMENTS"
          && !error.message.includes(arguments_.at(-1))
        ),
      );
    }
  });

  await suite.test("prints only restricted paths and receipt hash, never report contents", async () => {
    const marker = "SYNTHETIC-PRIVATE-LICENSE-CONTENT";
    const fixture = createFixture();
    fixture.inspections[0] = inspectionFor(fixture.lockedPackages[0], {
      licenseText: `${marker}\n`,
    });
    const stdout = captureStream();
    const stderr = captureStream();
    let result;
    try {
      const status = await reviewMain([], {
        root: fixture.root,
        runReview: async ({ root }) => {
          assert.equal(root, fixture.root);
          result = await runFixture(fixture);
          return result;
        },
        stderr: stderr.stream,
        stdout: stdout.stream,
      });
      assert.equal(status, 0);
      assert.equal(stderr.value(), "");
      assert.equal(stdout.value().includes(result.reportPath), true);
      assert.equal(stdout.value().includes(result.receiptPath), true);
      assert.equal(stdout.value().includes(result.receiptSha256), true);
      assert.equal(stdout.value().includes("packages:"), false);
      assert.equal(stdout.value().includes(marker), false);
      assert.equal(readFileSync(result.reportPath, "utf8").includes(marker), true);

      const rejectedStdout = captureStream();
      const rejectedStderr = captureStream();
      const rejected = await reviewMain(["--output", marker], {
        root: fixture.root,
        stderr: rejectedStderr.stream,
        stdout: rejectedStdout.stream,
      });
      assert.equal(rejected, 1);
      assert.equal(rejectedStdout.value(), "");
      assert.equal(rejectedStderr.value().includes(marker), false);

      const failedStdout = captureStream();
      const failedStderr = captureStream();
      const failed = await reviewMain([], {
        root: fixture.root,
        runReview: async () => {
          throw new Error(marker);
        },
        stderr: failedStderr.stream,
        stdout: failedStdout.stream,
      });
      assert.equal(failed, 1);
      assert.equal(failedStdout.value(), "");
      assert.equal(failedStderr.value().includes(marker), false);
      assert.equal(failedStderr.value(), (
        "[SUPPLY_CHAIN_REVIEW_INTERNAL] "
        + "候选供应链审查未通过；详细错误与报告内容已抑制。\n"
      ));

      const classifiedStdout = captureStream();
      const classifiedStderr = captureStream();
      const classified = await reviewMain([], {
        root: fixture.root,
        runReview: async () => {
          throw new NpmIsolationError(
            "SUPPLY_CHAIN_REVIEW_INPUT_DRIFT",
            `${marker}: alpha@1.0.0 at /tmp/private-report.json`,
          );
        },
        stderr: classifiedStderr.stream,
        stdout: classifiedStdout.stream,
      });
      assert.equal(classified, 1);
      assert.equal(classifiedStdout.value(), "");
      assert.equal(classifiedStderr.value(), (
        "[SUPPLY_CHAIN_REVIEW_INPUT_DRIFT] "
        + "候选供应链审查未通过；详细错误与报告内容已抑制。\n"
      ));
      assert.equal(classifiedStderr.value().includes(marker), false);
      assert.equal(classifiedStderr.value().includes("alpha@1.0.0"), false);
      assert.equal(classifiedStderr.value().includes("/tmp/private-report.json"), false);
    } finally {
      cleanupFixture(fixture);
    }
  });
});

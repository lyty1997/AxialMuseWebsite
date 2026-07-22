import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DUAL_ENDPOINT_CI_RECEIPT_ENVELOPE,
  DUAL_ENDPOINT_CI_RUNTIME,
  dualEndpointCiReceiptBytes,
  validateDualEndpointCiReceipt,
} from "../../scripts/quality/lib/supply-chain/dual-endpoint-ci.mjs";
import { NpmIsolationError } from "../../scripts/quality/lib/supply-chain/errors.mjs";
import {
  FINAL_ADMISSION_RECEIPT_ENVELOPE,
  createFinalAdmissionReceipt,
  parseFinalAdmissionReceipt,
  renderFinalAdmissionReceipt,
  runFinalSupplyChainAdmission,
  validateFinalAdmissionReceipt,
} from "../../scripts/quality/lib/supply-chain/final-admission-runner.mjs";
import { canonicalJsonBytes } from "../../scripts/quality/lib/supply-chain/spdx.mjs";
import {
  formatFinalSupplyChainAdmissionError,
  main as cliMain,
  parseFinalSupplyChainAdmissionArguments,
} from "../../scripts/quality/run-final-supply-chain-admission.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hash(character) {
  return character.repeat(64);
}

function fixedInputs() {
  return {
    ".npmrc": hash("1"),
    ".nvmrc": hash("2"),
    "docs/contracts/dependency-license-evidence.json": hash("c"),
    "docs/contracts/dependency-policy.json": hash("d"),
    "package-lock.json": hash("3"),
    "package.json": hash("4"),
  };
}

function dualInputs(inputs = fixedInputs()) {
  return {
    ".npmrc": inputs[".npmrc"],
    ".nvmrc": inputs[".nvmrc"],
    "package-lock.json": inputs["package-lock.json"],
    "package.json": inputs["package.json"],
  };
}

function evidenceSummary(overrides = {}) {
  const summary = {
    version: "0.1.0",
    kind: "axial_muse_final_admission_evidence",
    status: "approved",
    owner: "AxialMuseWebsite",
    decisionId: "D-077",
    decidedAt: "2026-07-20T00:00:00Z",
    admissionsSha256: hash("5"),
    auditRawSha256: hash("6"),
    auditReceiptSha256: hash("7"),
    candidateReceiptSha256: hash("7"),
    candidateReportSha256: hash("8"),
    dependencyEvidenceSha256: hash("9"),
    noticesSha256: hash("a"),
    sbomSha256: hash("b"),
    finalDecisionSha256: null,
    inputs: fixedInputs(),
    candidatePackageCount: 3,
    audit: {
      outcome: "pass",
      dependencyTotal: 3,
      total: 1,
      info: 0,
      low: 1,
      moderate: 0,
      high: 0,
      critical: 0,
    },
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "finalDecisionSha256")) {
    summary.finalDecisionSha256 = sha256(canonicalJsonBytes({
      version: summary.version,
      kind: "axial_muse_final_admission_decision",
      status: summary.status,
      owner: summary.owner,
      decisionId: summary.decisionId,
      decidedAt: summary.decidedAt,
      admissionsSha256: summary.admissionsSha256,
      auditRawSha256: summary.auditRawSha256,
      auditReceiptSha256: summary.auditReceiptSha256,
      candidateReceiptSha256: summary.candidateReceiptSha256,
      candidateReportSha256: summary.candidateReportSha256,
      dependencyEvidenceSha256: summary.dependencyEvidenceSha256,
      noticesSha256: summary.noticesSha256,
      sbomSha256: summary.sbomSha256,
    }));
  }
  return summary;
}

function endpoint(role, inputs) {
  return {
    role,
    ...DUAL_ENDPOINT_CI_RUNTIME[role],
    before: {
      lockfileSha256: inputs["package-lock.json"],
      manifestSha256: inputs["package.json"],
    },
    after: {
      lockfileSha256: inputs["package-lock.json"],
      manifestSha256: inputs["package.json"],
    },
  };
}

function dualReceipt(summaryInputs = fixedInputs()) {
  const inputs = dualInputs(summaryInputs);
  return validateDualEndpointCiReceipt({
    ...DUAL_ENDPOINT_CI_RECEIPT_ENVELOPE,
    inputs,
    endpoints: [endpoint("primary", inputs), endpoint("minimum", inputs)],
  });
}

function createFixture() {
  const outer = mkdtempSync("/tmp/axial-muse-final-runner-test-");
  const root = join(outer, "project-root-do-not-leak");
  const temporaryParent = join(outer, "receipts");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(temporaryParent, { mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(temporaryParent, 0o700);
  const paths = {
    candidateReportPath: join(outer, "candidate", "report.json"),
    candidateReceiptPath: join(outer, "candidate", "receipt.json"),
    auditRawPath: join(outer, "audit", "raw-audit.json"),
    auditReceiptPath: join(outer, "audit", "receipt.json"),
    finalDecisionPath: join(outer, "decision", "final-decision.json"),
  };
  return { outer, paths, root, temporaryParent };
}

function removeFixture(fixture) {
  rmSync(fixture.outer, { force: true, recursive: true });
}

function expectCode(action, code) {
  assert.throws(
    action,
    (error) => error instanceof NpmIsolationError && error.code === code,
  );
}

async function expectCodeAsync(action, code) {
  await assert.rejects(
    action,
    (error) => error instanceof NpmIsolationError && error.code === code,
  );
}

function fakeEvidence(events, {
  closeThrows = false,
  failAssertion = null,
  summary = evidenceSummary(),
} = {}) {
  let assertions = 0;
  let closes = 0;
  return {
    handle: {
      summary,
      assertCurrent() {
        assertions += 1;
        events.push(`assert:${assertions}`);
        if (assertions === failAssertion) {
          throw new NpmIsolationError(
            "SYNTHETIC_EVIDENCE_DRIFT",
            "synthetic evidence drift",
          );
        }
        return summary;
      },
      close() {
        closes += 1;
        events.push(`close:${closes}`);
        if (closes !== 1) throw new Error("close called more than once");
        if (closeThrows) throw new Error("synthetic close failure");
      },
    },
    get assertions() { return assertions; },
    get closes() { return closes; },
  };
}

function runnerOptions(fixture, evidence, events, overrides = {}) {
  return {
    root: fixture.root,
    ...fixture.paths,
    temporaryParent: fixture.temporaryParent,
    openEvidence(options) {
      events.push("open");
      assert.deepEqual(options, { root: fixture.root, ...fixture.paths });
      return evidence.handle;
    },
    async runDual(options) {
      events.push("dual");
      assert.deepEqual(options, {
        root: fixture.root,
        temporaryParent: fixture.temporaryParent,
      });
      return {
        receipt: dualReceipt(),
        receiptPath: join(fixture.outer, "independent-dual-receipt", "receipt.json"),
      };
    },
    ...overrides,
  };
}

function cliArguments(paths) {
  return [
    "--candidate-report", paths.candidateReportPath,
    "--candidate-receipt", paths.candidateReceiptPath,
    "--audit-raw", paths.auditRawPath,
    "--audit-receipt", paths.auditReceiptPath,
    "--final-decision", paths.finalDecisionPath,
  ];
}

test("D-077 final supply-chain admission runner", async (suite) => {
  await suite.test("validates one canonical composite receipt and all cross-stage bindings", () => {
    const admissionEvidence = evidenceSummary();
    const dualEndpointReceipt = dualReceipt();
    const receipt = createFinalAdmissionReceipt({ admissionEvidence, dualEndpointReceipt });
    assert.deepEqual(receipt.envelope, FINAL_ADMISSION_RECEIPT_ENVELOPE);
    assert.equal(
      receipt.dualEndpointReceiptSha256,
      sha256(dualEndpointCiReceiptBytes(dualEndpointReceipt)),
    );
    assert.deepEqual(validateFinalAdmissionReceipt(receipt), receipt);

    const text = renderFinalAdmissionReceipt(receipt);
    assert.equal(Buffer.byteLength(text), Buffer.from(text).length);
    assert.equal(Buffer.byteLength(text) <= 32 * 1024, true);
    assert.equal(text, canonicalJsonBytes(JSON.parse(text)));
    assert.deepEqual(parseFinalAdmissionReceipt(text), receipt);
    assert.deepEqual(parseFinalAdmissionReceipt(Buffer.from(text)), receipt);

    expectCode(
      () => validateFinalAdmissionReceipt({ ...receipt, unreviewed: true }),
      "FINAL_ADMISSION_RECEIPT_SCHEMA",
    );
    expectCode(
      () => validateFinalAdmissionReceipt({
        ...receipt,
        envelope: { ...receipt.envelope, status: "pending" },
      }),
      "FINAL_ADMISSION_RECEIPT_SCHEMA",
    );
    expectCode(
      () => validateFinalAdmissionReceipt({
        ...receipt,
        dualEndpointReceiptSha256: hash("f"),
      }),
      "FINAL_ADMISSION_RECEIPT_BINDING",
    );
    expectCode(
      () => createFinalAdmissionReceipt({
        admissionEvidence: evidenceSummary({ auditReceiptSha256: hash("d") }),
        dualEndpointReceipt,
      }),
      "FINAL_ADMISSION_RECEIPT_BINDING",
    );
    expectCode(
      () => createFinalAdmissionReceipt({
        admissionEvidence: evidenceSummary({
          inputs: { ...fixedInputs(), ".npmrc": hash("e") },
        }),
        dualEndpointReceipt,
      }),
      "FINAL_ADMISSION_RECEIPT_BINDING",
    );
  });

  await suite.test("rejects malformed UTF-8, duplicate keys, non-canonical bytes and oversize", () => {
    const text = renderFinalAdmissionReceipt(createFinalAdmissionReceipt({
      admissionEvidence: evidenceSummary(),
      dualEndpointReceipt: dualReceipt(),
    }));
    expectCode(
      () => parseFinalAdmissionReceipt(Buffer.from([0xc3, 0x28])),
      "FINAL_ADMISSION_RECEIPT_BYTES",
    );
    expectCode(
      () => parseFinalAdmissionReceipt(Buffer.alloc(32 * 1024 + 1, 0x20)),
      "FINAL_ADMISSION_RECEIPT_BYTES",
    );
    expectCode(
      () => parseFinalAdmissionReceipt(JSON.stringify(JSON.parse(text))),
      "FINAL_ADMISSION_RECEIPT_BYTES",
    );
    const duplicate = text.replace(
      "{\n  \"admissionEvidence\":",
      "{\n  \"admissionEvidence\": {},\n  \"admissionEvidence\":",
    );
    expectCode(
      () => parseFinalAdmissionReceipt(duplicate),
      "FINAL_ADMISSION_RECEIPT_BYTES",
    );
  });

  await suite.test("opens evidence first, runs dual endpoints only after assertion, then reasserts around persistence", async () => {
    const fixture = createFixture();
    const events = [];
    const evidence = fakeEvidence(events);
    try {
      const result = await runFinalSupplyChainAdmission(runnerOptions(
        fixture,
        evidence,
        events,
        {
          afterReceiptStaged() { events.push("staged"); },
          beforeReceiptPublish() { events.push("publish"); },
        },
      ));
      assert.deepEqual(events, [
        "open",
        "assert:1",
        "dual",
        "assert:2",
        "staged",
        "publish",
        "assert:3",
        "close:1",
      ]);
      assert.equal(evidence.assertions, 3);
      assert.equal(evidence.closes, 1);

      const directory = result.receiptPath.slice(0, result.receiptPath.lastIndexOf("/"));
      assert.deepEqual(readdirSync(directory), ["receipt.json"]);
      const fileStat = lstatSync(result.receiptPath);
      const directoryStat = lstatSync(directory);
      assert.equal(fileStat.isFile(), true);
      assert.equal(fileStat.nlink, 1);
      assert.equal(fileStat.mode & 0o777, 0o600);
      assert.equal(directoryStat.isDirectory(), true);
      assert.equal(directoryStat.mode & 0o777, 0o700);

      const bytes = readFileSync(result.receiptPath);
      assert.deepEqual(parseFinalAdmissionReceipt(bytes), result.receipt);
      const text = bytes.toString("utf8");
      assert.equal(text.includes("fixture-package-name-must-not-leak"), false);
      assert.equal(text.includes(fixture.root), false);
      assert.equal(text.includes(fixture.paths.candidateReportPath), false);
      assert.equal(text.includes("PATH"), false);
      assert.equal(text.includes("HOME"), false);
      assert.equal(result.dualEndpointReceiptPath.includes("independent-dual-receipt"), true);
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("does not persist a final receipt when dual execution or binding fails", async () => {
    const dualFailureFixture = createFixture();
    const dualFailureEvents = [];
    const dualFailureEvidence = fakeEvidence(dualFailureEvents);
    try {
      await expectCodeAsync(
        runFinalSupplyChainAdmission(runnerOptions(
          dualFailureFixture,
          dualFailureEvidence,
          dualFailureEvents,
          {
            async runDual() {
              dualFailureEvents.push("dual");
              throw new Error("sensitive synthetic dual failure");
            },
          },
        )),
        "FINAL_ADMISSION_ORCHESTRATION",
      );
      assert.deepEqual(dualFailureEvents, ["open", "assert:1", "dual", "close:1"]);
      assert.deepEqual(readdirSync(dualFailureFixture.temporaryParent), []);
      assert.equal(dualFailureEvidence.closes, 1);
    } finally {
      removeFixture(dualFailureFixture);
    }

    const bindingFixture = createFixture();
    const bindingEvents = [];
    const bindingEvidence = fakeEvidence(bindingEvents);
    try {
      const mismatchedInputs = { ...fixedInputs(), ".nvmrc": hash("f") };
      await expectCodeAsync(
        runFinalSupplyChainAdmission(runnerOptions(
          bindingFixture,
          bindingEvidence,
          bindingEvents,
          {
            async runDual() {
              bindingEvents.push("dual");
              return {
                receipt: dualReceipt(mismatchedInputs),
                receiptPath: join(bindingFixture.outer, "dual", "receipt.json"),
              };
            },
          },
        )),
        "FINAL_ADMISSION_RECEIPT_BINDING",
      );
      assert.deepEqual(bindingEvents, ["open", "assert:1", "dual", "close:1"]);
      assert.deepEqual(readdirSync(bindingFixture.temporaryParent), []);
      assert.equal(bindingEvidence.closes, 1);
    } finally {
      removeFixture(bindingFixture);
    }
  });

  await suite.test("removes staged or published receipt when final evidence assertion or close fails", async () => {
    const driftFixture = createFixture();
    const driftEvents = [];
    const driftEvidence = fakeEvidence(driftEvents, { failAssertion: 3 });
    try {
      await expectCodeAsync(
        runFinalSupplyChainAdmission(runnerOptions(
          driftFixture,
          driftEvidence,
          driftEvents,
          { afterReceiptStaged() { driftEvents.push("staged"); } },
        )),
        "SYNTHETIC_EVIDENCE_DRIFT",
      );
      assert.deepEqual(driftEvents, [
        "open", "assert:1", "dual", "assert:2", "staged", "assert:3", "close:1",
      ]);
      assert.deepEqual(readdirSync(driftFixture.temporaryParent), []);
      assert.equal(driftEvidence.closes, 1);
    } finally {
      removeFixture(driftFixture);
    }

    const closeFixture = createFixture();
    const closeEvents = [];
    const closeEvidence = fakeEvidence(closeEvents, { closeThrows: true });
    try {
      await expectCodeAsync(
        runFinalSupplyChainAdmission(runnerOptions(closeFixture, closeEvidence, closeEvents)),
        "FINAL_ADMISSION_EVIDENCE_CLOSE",
      );
      assert.deepEqual(readdirSync(closeFixture.temporaryParent), []);
      assert.equal(closeEvidence.closes, 1);
    } finally {
      removeFixture(closeFixture);
    }
  });

  await suite.test("cleans a deterministic persistence failure without leaving success-like bytes", async () => {
    const fixture = createFixture();
    const events = [];
    const evidence = fakeEvidence(events);
    try {
      await expectCodeAsync(
        runFinalSupplyChainAdmission(runnerOptions(fixture, evidence, events, {
          syncFile() {
            throw new Error("synthetic fsync failure");
          },
        })),
        "FINAL_ADMISSION_RECEIPT_WRITE",
      );
      assert.deepEqual(readdirSync(fixture.temporaryParent), []);
      assert.equal(evidence.closes, 1);
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("preserves a replaced pending path and reports cleanup uncertainty", async () => {
    const fixture = createFixture();
    const events = [];
    const evidence = fakeEvidence(events);
    let pendingPath;
    let movedPath;
    try {
      await expectCodeAsync(
        runFinalSupplyChainAdmission(runnerOptions(fixture, evidence, events, {
          afterReceiptStaged(paths) {
            pendingPath = paths.pendingPath;
            movedPath = `${pendingPath}.task-original`;
            renameSync(pendingPath, movedPath);
            writeFileSync(pendingPath, "external replacement\n", { mode: 0o600 });
            chmodSync(pendingPath, 0o600);
          },
        })),
        "FINAL_ADMISSION_RECEIPT_CLEANUP_UNCERTAIN",
      );
      assert.equal(readFileSync(pendingPath, "utf8"), "external replacement\n");
      assert.equal(lstatSync(movedPath).isFile(), true);
      assert.equal(readdirSync(dirname(pendingPath)).includes("receipt.json"), false);
      assert.equal(evidence.closes, 1);
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("rejects a preoccupied final name without replacing external bytes", async () => {
    const fixture = createFixture();
    const events = [];
    const evidence = fakeEvidence(events);
    let finalPath;
    try {
      await expectCodeAsync(
        runFinalSupplyChainAdmission(runnerOptions(fixture, evidence, events, {
          beforeReceiptPublish(paths) {
            finalPath = paths.finalPath;
            writeFileSync(finalPath, "external final occupant\n", { mode: 0o600 });
            chmodSync(finalPath, 0o600);
          },
        })),
        "FINAL_ADMISSION_RECEIPT_CLEANUP_UNCERTAIN",
      );
      assert.equal(readFileSync(finalPath, "utf8"), "external final occupant\n");
      assert.equal(evidence.closes, 1);
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("preserves a mode-drifted pending inode instead of deleting by path", async () => {
    const fixture = createFixture();
    const events = [];
    const evidence = fakeEvidence(events);
    let syncCalls = 0;
    try {
      await expectCodeAsync(
        runFinalSupplyChainAdmission(runnerOptions(fixture, evidence, events, {
          syncFile(descriptor) {
            syncCalls += 1;
            fchmodSync(descriptor, 0o640);
          },
        })),
        "FINAL_ADMISSION_RECEIPT_CLEANUP_UNCERTAIN",
      );
      assert.equal(syncCalls, 1);
      const directories = readdirSync(fixture.temporaryParent);
      assert.equal(directories.length, 1);
      const pendingPath = join(fixture.temporaryParent, directories[0], "receipt.pending");
      assert.equal(lstatSync(pendingPath).mode & 0o777, 0o640);
      assert.equal(evidence.closes, 1);
    } finally {
      removeFixture(fixture);
    }
  });

  await suite.test("CLI accepts five canonical inputs and prints only the two resulting receipt paths", async () => {
    const fixture = createFixture();
    try {
      const argv = cliArguments(fixture.paths);
      assert.deepEqual(
        parseFinalSupplyChainAdmissionArguments(argv),
        fixture.paths,
      );
      expectCode(
        () => parseFinalSupplyChainAdmissionArguments([
          ...argv.slice(2, 4),
          ...argv.slice(0, 2),
          ...argv.slice(4),
        ]),
        "FINAL_ADMISSION_ARGUMENTS",
      );
      expectCode(
        () => parseFinalSupplyChainAdmissionArguments([
          ...argv.slice(0, 1),
          "relative/report.json",
          ...argv.slice(2),
        ]),
        "FINAL_ADMISSION_ARGUMENTS",
      );
      expectCode(
        () => parseFinalSupplyChainAdmissionArguments([...argv, "--root", fixture.root]),
        "FINAL_ADMISSION_ARGUMENTS",
      );
      expectCode(
        () => parseFinalSupplyChainAdmissionArguments([
          ...argv.slice(0, 3),
          fixture.paths.candidateReportPath,
          ...argv.slice(4),
        ]),
        "FINAL_ADMISSION_ARGUMENTS",
      );

      let call;
      let output = "";
      const expectedResult = Object.freeze({
        dualEndpointReceiptPath: join(fixture.temporaryParent, "dual", "receipt.json"),
        receiptPath: join(fixture.temporaryParent, "final", "receipt.json"),
      });
      const result = await cliMain(argv, {
        async runAdmission(options) {
          call = options;
          return expectedResult;
        },
        standardOutput: {
          write(chunk) { output += chunk; },
        },
      });
      assert.equal(call.root.startsWith("/"), true);
      assert.deepEqual(
        Object.fromEntries(Object.entries(call).filter(([key]) => key !== "root")),
        fixture.paths,
      );
      assert.equal(result, expectedResult);
      assert.equal(
        output,
        `最终供应链准入通过。\nComposite receipt: ${expectedResult.receiptPath}\nDual-endpoint receipt: ${expectedResult.dualEndpointReceiptPath}\n`,
      );
      assert.equal(output.includes(expectedResult.receiptPath), true);
      assert.equal(output.includes(expectedResult.dualEndpointReceiptPath), true);
      for (const path of Object.values(fixture.paths)) {
        assert.equal(output.includes(path), false);
      }
      assert.equal(output.includes(fixture.root), false);
      assert.equal(output.includes("fixture-package-name"), false);
      assert.equal(output.includes("PATH="), false);

      let failureOutput = "";
      await expectCodeAsync(
        cliMain(argv, {
          async runAdmission() {
            throw new NpmIsolationError(
              "SUPPLY_CHAIN_NOTICE_SOURCE",
              "fixture-package-name /private/project PATH=secret npm stderr sentinel",
            );
          },
          standardError: {
            write(chunk) { failureOutput += chunk; },
          },
          standardOutput: {
            write() { throw new Error("success output must not run"); },
          },
        }),
        "SUPPLY_CHAIN_NOTICE_SOURCE",
      );
      assert.equal(
        failureOutput,
        "[SUPPLY_CHAIN_NOTICE_SOURCE] 最终供应链准入失败；证据详情、包身份、本机路径、环境值与子进程输出已抑制。\n",
      );
      for (const sentinel of [
        "fixture-package-name",
        "/private/project",
        "PATH=secret",
        "npm stderr sentinel",
      ]) {
        assert.equal(failureOutput.includes(sentinel), false);
      }
      assert.equal(
        formatFinalSupplyChainAdmissionError(new Error("PATH=another-secret")),
        "[FINAL_ADMISSION_INTERNAL] 最终供应链准入失败；证据详情、包身份、本机路径、环境值与子进程输出已抑制。",
      );
    } finally {
      removeFixture(fixture);
    }
  });
});

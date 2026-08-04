import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {
  checkCiWorkflow,
  checkCiWorkflowSource,
  CiWorkflowError,
} from "../../scripts/quality/lib/ci-workflow.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CANONICAL = readFileSync(
  resolve(ROOT, ".github/workflows/ci.yml"),
  "utf8",
);
const JOB_NAMES = Object.freeze([
  "website-quality",
  "node-minimum",
  "diagrams",
  "supply-chain",
  "production-artifact",
]);
const BUILD_JOB_NAMES = Object.freeze([
  "website-quality",
  "node-minimum",
]);
const PREREQUISITE_JOB_NAMES = Object.freeze([
  "website-quality",
  "node-minimum",
  "diagrams",
  "supply-chain",
]);
const PRIMARY_NODE_JOB_NAMES = Object.freeze([
  "website-quality",
  "diagrams",
  "supply-chain",
  "production-artifact",
]);
const PRIVATE_RUNTIME_JOB_NAMES = Object.freeze([
  "website-quality",
  "node-minimum",
  "supply-chain",
  "production-artifact",
]);
const JOB_ANCHORS = Object.freeze({
  "website-quality": "      - name: Frozen dependency install",
  "node-minimum": "      - name: Frozen dependency install",
  diagrams: "      - name: Set up Java",
  "supply-chain": "      - name: Static supply chain evidence",
  "production-artifact": "      - name: Frozen dependency install",
});
const JOB_TIMEOUTS = Object.freeze({
  "website-quality": 45,
  "node-minimum": 45,
  diagrams: 15,
  "supply-chain": 20,
  "production-artifact": 60,
});
const JOB_RUN_COMMANDS = Object.freeze({
  "website-quality": "node scripts/quality/run-isolated-npm.mjs ci",
  "node-minimum": "node scripts/quality/run-isolated-npm.mjs ci",
  diagrams: "node scripts/quality/check-diagrams.mjs",
  "supply-chain": "node scripts/quality/check-supply-chain.mjs",
  "production-artifact": "node scripts/quality/check-production-artifact-outputs.mjs",
});

function replaceOnce(source, search, replacement) {
  const index = source.indexOf(search);
  assert.notEqual(index, -1, `fixture mutation target missing: ${search}`);
  return `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`;
}

function replaceInJob(source, jobName, search, replacement) {
  const header = `  ${jobName}:\n`;
  const jobStart = source.indexOf(header);
  assert.notEqual(jobStart, -1, `fixture job missing: ${jobName}`);
  const bodyStart = jobStart + header.length;
  const nextJob = /^  [a-z][a-z0-9-]*:\n/mu.exec(source.slice(bodyStart));
  const jobEnd = nextJob === null ? source.length : bodyStart + nextJob.index;
  const jobSource = source.slice(jobStart, jobEnd);
  const targetIndex = jobSource.indexOf(search);
  assert.notEqual(
    targetIndex,
    -1,
    `fixture mutation target missing from ${jobName}: ${search}`,
  );
  assert.equal(
    jobSource.indexOf(search, targetIndex + search.length),
    -1,
    `fixture mutation target is ambiguous in ${jobName}: ${search}`,
  );
  const absoluteIndex = jobStart + targetIndex;
  return `${source.slice(0, absoluteIndex)}${replacement}${source.slice(absoluteIndex + search.length)}`;
}

function expectCode(source, code) {
  assert.throws(
    () => checkCiWorkflowSource(source),
    (error) => error instanceof CiWorkflowError && error.code === code,
  );
}

function withTemporaryRoot(callback) {
  const root = mkdtempSync(join(tmpdir(), "axial-muse-ci-workflow-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

test("CODE-020 canonical CI topology passes with five jobs and pinned Actions", () => {
  assert.deepEqual(checkCiWorkflowSource(CANONICAL), {
    actionCount: 12,
    jobCount: 5,
  });
});

test("CODE-020 repository workflow file set contains only regular ci.yml", () => {
  withTemporaryRoot((root) => {
    const directory = join(root, ".github", "workflows");
    mkdirSync(directory, {recursive: true});
    writeFileSync(join(directory, "ci.yml"), CANONICAL, "utf8");
    assert.deepEqual(checkCiWorkflow(root), {
      actionCount: 12,
      jobCount: 5,
    });
    writeFileSync(
      join(directory, "release.yml"),
      "name: bypass\non: push\njobs: {}\n",
      "utf8",
    );
    assert.throws(
      () => checkCiWorkflow(root),
      (error) => (
        error instanceof CiWorkflowError
        && error.code === "CI_WORKFLOW_FILE_SET"
      ),
    );
  });
  withTemporaryRoot((root) => {
    const directory = join(root, ".github", "workflows");
    mkdirSync(directory, {recursive: true});
    const target = join(root, "ci-target.yml");
    writeFileSync(target, CANONICAL, "utf8");
    symlinkSync(target, join(directory, "ci.yml"));
    assert.throws(
      () => checkCiWorkflow(root),
      (error) => (
        error instanceof CiWorkflowError
        && error.code === "CI_WORKFLOW_FILE_SET"
      ),
    );
  });
});

test("D-097 concurrency cancellation is mandatory", () => {
  expectCode(
    replaceOnce(
      CANONICAL,
      "  cancel-in-progress: true",
      "  cancel-in-progress: false",
    ),
    "CI_WORKFLOW_HEADER",
  );
});

test("D-097 pull request、dev 与 main 触发器缺一不可", () => {
  for (const [search, replacement] of [
    ["  pull_request:\n", ""],
    ["      - main\n", "      - release\n"],
    ["      - dev\n", "      - feature\n"],
  ]) {
    expectCode(
      replaceOnce(CANONICAL, search, replacement),
      "CI_WORKFLOW_HEADER",
    );
  }
});

test("D-097 exact job set rejects a renamed minimum job", () => {
  expectCode(
    replaceOnce(CANONICAL, "  node-minimum:", "  node-floor:"),
    "CI_WORKFLOW_JOBS",
  );
});

test("D-097 floating and unapproved Action references fail", () => {
  for (const jobName of JOB_NAMES) {
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
        "actions/checkout@v5",
      ),
      "CI_WORKFLOW_ACTION_PIN",
    );
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
        "actions/checkout@0000000000000000000000000000000000000000",
      ),
      "CI_WORKFLOW_ACTION_SET",
    );
  }
  for (const jobName of JOB_NAMES) {
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        "actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444",
        "actions/setup-node@v5",
      ),
      "CI_WORKFLOW_ACTION_PIN",
    );
  }
  expectCode(
    replaceInJob(
      CANONICAL,
      "diagrams",
      "actions/setup-java@03ad4de0992f5dab5e18fcb136590ce7c4a0ac95",
      "actions/setup-java@v5",
    ),
    "CI_WORKFLOW_ACTION_PIN",
  );
  expectCode(
    replaceInJob(
      CANONICAL,
      "production-artifact",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      "actions/upload-artifact@v7",
    ),
    "CI_WORKFLOW_ACTION_PIN",
  );
  expectCode(
    replaceInJob(
      CANONICAL,
      "production-artifact",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      "actions/upload-artifact@0000000000000000000000000000000000000000",
    ),
    "CI_WORKFLOW_ACTION_SET",
  );
});

test("E-013 both quality jobs require full history and no persisted credentials", () => {
  for (const jobName of BUILD_JOB_NAMES) {
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        "          fetch-depth: 0",
        "          fetch-depth: 1",
      ),
      "CI_WORKFLOW_JOB_STEPS",
    );
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        "          persist-credentials: false",
        "          persist-credentials: true",
      ),
      "CI_WORKFLOW_JOB_STEPS",
    );
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        "          fetch-depth: 0\n          persist-credentials: false",
        "          fetch-depth: 0\n          persist-credentials: false\n          ref: ${{ github.sha }}",
      ),
      "CI_WORKFLOW_JOB_STEPS",
    );
  }
});

test("E-015 producer checks out the exact full SHA without partial checkout", () => {
  for (const [search, replacement] of [
    ["          ref: ${{ github.sha }}", "          ref: main"],
    ["          fetch-depth: 0", "          fetch-depth: 1"],
    [
      "          persist-credentials: false",
      "          persist-credentials: true",
    ],
    [
      "          fetch-depth: 0\n          persist-credentials: false",
      "          fetch-depth: 0\n          persist-credentials: false\n          sparse-checkout: src",
    ],
  ]) {
    expectCode(
      replaceInJob(
        CANONICAL,
        "production-artifact",
        search,
        replacement,
      ),
      "CI_WORKFLOW_JOB_STEPS",
    );
  }
});

test("E-015 producer runs the zero-dependency fresh workspace preflight", () => {
  expectCode(
    replaceInJob(
      CANONICAL,
      "production-artifact",
      "node scripts/quality/check-production-artifact-workspace.mjs",
      "git status --porcelain",
    ),
    "CI_WORKFLOW_JOB_STEPS",
  );
});

test("D-067 primary and minimum Node endpoints cannot drift", () => {
  for (const jobName of PRIMARY_NODE_JOB_NAMES) {
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        "          node-version-file: \".nvmrc\"",
        "          node-version: \"24\"",
      ),
      "CI_WORKFLOW_JOB_STEPS",
    );
  }
  expectCode(
    replaceInJob(
      CANONICAL,
      "node-minimum",
      "          node-version: \"24.16.0\"",
      "          node-version: \"24.17.0\"",
    ),
    "CI_WORKFLOW_JOB_STEPS",
  );
  expectCode(
    replaceInJob(
      CANONICAL,
      "diagrams",
      "process.versions.node + \"\\n\"",
      "process.versions.node",
    ),
    "CI_WORKFLOW_JOB_STEPS",
  );
});

test("E-010 setup-node cache and shared cache Actions are rejected", () => {
  for (const jobName of JOB_NAMES) {
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        "          package-manager-cache: false",
        "          package-manager-cache: false\n          cache: npm",
      ),
      "CI_WORKFLOW_CACHE",
    );
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        JOB_ANCHORS[jobName],
        `      - name: Restore cache\n        uses: actions/cache@0000000000000000000000000000000000000000\n\n${JOB_ANCHORS[jobName]}`,
      ),
      "CI_WORKFLOW_CACHE",
    );
  }
});

test("D-102 isolated install, zero-dependency quality, history and shared workloads are mandatory", () => {
  for (const jobName of BUILD_JOB_NAMES) {
    for (const [command, replacement] of [
      [
        "node scripts/quality/run-isolated-npm.mjs ci",
        "npm ci",
      ],
      [
        "node scripts/quality/run-isolated-npm.mjs run-script quality",
        "node scripts/quality/run-quality.mjs",
      ],
      [
        "node scripts/quality/run-content-history.mjs",
        "node scripts/quality/check-content-history.mjs",
      ],
      [
        "node scripts/quality/run-isolated-npm.mjs run-script typecheck",
        "node --version",
      ],
      [
        "node scripts/quality/run-isolated-npm.mjs run-script test",
        "node --test",
      ],
      [
        "node scripts/quality/run-isolated-npm.mjs run-script build",
        "node --version",
      ],
    ]) {
      expectCode(
        replaceInJob(CANONICAL, jobName, command, replacement),
        "CI_WORKFLOW_JOB_STEPS",
      );
    }
  }
});

test("E-015 producer reruns the full primary workload before adjacent release commands", () => {
  for (const [command, replacement] of [
    [
      "node scripts/quality/run-isolated-npm.mjs ci",
      "npm ci",
    ],
    [
      "node scripts/quality/run-isolated-npm.mjs run-script quality",
      "node scripts/quality/run-quality.mjs",
    ],
    [
      "node scripts/quality/run-content-history.mjs",
      "node scripts/quality/check-content-history.mjs",
    ],
    [
      "node scripts/quality/run-isolated-npm.mjs run-script typecheck",
      "node --version",
    ],
    [
      "node scripts/quality/run-isolated-npm.mjs run-script test",
      "node --test",
    ],
    [
      "node scripts/quality/run-isolated-npm.mjs run-script build",
      "node --version",
    ],
    [
      "node scripts/quality/run-isolated-npm.mjs run-script package:artifact",
      "node scripts/release/package-site.mjs",
    ],
    [
      "node scripts/quality/run-isolated-npm.mjs run-script check:artifact",
      "node scripts/quality/check-release-package.mjs",
    ],
    [
      "node scripts/quality/prepare-production-artifact-upload.mjs",
      "echo upload-seal",
    ],
  ]) {
    expectCode(
      replaceInJob(
        CANONICAL,
        "production-artifact",
        command,
        replacement,
      ),
      "CI_WORKFLOW_JOB_STEPS",
    );
  }
});

test("CODE-020 upload immediately follows the single release digest check", () => {
  expectCode(
    replaceInJob(
      CANONICAL,
      "production-artifact",
      "\n\n      - name: Upload production artifact",
      `\n\n      - name: Replace checked release
        run: cp -R other-release dist/release

      - name: Upload production artifact`,
    ),
    "CI_WORKFLOW_JOB_STEPS",
  );
  expectCode(
    replaceInJob(
      CANONICAL,
      "production-artifact",
      "      - name: Package production artifact",
      `      - name: Second production build
        run: node scripts/quality/run-isolated-npm.mjs run-script build

      - name: Package production artifact`,
    ),
    "CI_WORKFLOW_JOB_STEPS",
  );
});

test("CODE-020 upload is single, exact, immutable and ZIP-shaped", () => {
  for (const [search, replacement] of [
    [
      "          name: axial-muse-site-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
      "          name: axial-muse-site-latest",
    ],
    ["          path: dist/release/", "          path: dist/**"],
    ["          if-no-files-found: error", "          if-no-files-found: warn"],
    ["          retention-days: 30", "          retention-days: 90"],
    ["          compression-level: 6", "          compression-level: 0"],
    ["          overwrite: false", "          overwrite: true"],
    [
      "          include-hidden-files: false",
      "          include-hidden-files: true",
    ],
    ["          archive: true", "          archive: false"],
  ]) {
    expectCode(
      replaceInJob(
        CANONICAL,
        "production-artifact",
        search,
        replacement,
      ),
      "CI_WORKFLOW_JOB_STEPS",
    );
  }
  expectCode(
    replaceInJob(
      CANONICAL,
      "production-artifact",
      "      - name: Validate production artifact outputs",
      `      - name: Upload production artifact again
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: duplicate
          path: dist/release/

      - name: Validate production artifact outputs`,
    ),
    "CI_WORKFLOW_ACTION_SET",
  );
});

test("CODE-020 job outputs come only from the validated identity step", () => {
  for (const [search, replacement] of [
    [
      "      artifact-id: ${{ steps.identity.outputs.artifact-id }}",
      "      artifact-id: ${{ steps.upload.outputs.artifact-id }}",
    ],
    [
      "      artifact-digest: ${{ steps.identity.outputs.artifact-digest }}",
      "      artifact-digest: ${{ steps.upload.outputs.artifact-digest }}",
    ],
    [
      "      release-content-sha256: ${{ steps.identity.outputs.release-content-sha256 }}",
      "      release-content-sha256: ${{ steps.release.outputs.release-content-sha256 }}",
    ],
    [
      "          AXIAL_ARTIFACT_ID: ${{ steps.upload.outputs.artifact-id }}",
      "          AXIAL_ARTIFACT_ID: ${{ steps.upload.outputs.artifact-url }}",
    ],
    [
      "          AXIAL_ARTIFACT_DIGEST: ${{ steps.upload.outputs.artifact-digest }}",
      "          AXIAL_ARTIFACT_DIGEST: ${{ steps.release.outputs.release-content-sha256 }}",
    ],
    [
      "          AXIAL_BUILD_OPERATIONAL_SHA256: ${{ steps.release.outputs.build-operational-sha256 }}",
      "          AXIAL_BUILD_OPERATIONAL_SHA256: ${{ steps.upload.outputs.artifact-digest }}",
    ],
    [
      "          AXIAL_RELEASE_CONTENT_SHA256: ${{ steps.release.outputs.release-content-sha256 }}",
      "          AXIAL_RELEASE_CONTENT_SHA256: ${{ steps.upload.outputs.artifact-digest }}",
    ],
    [
      "          AXIAL_RELEASE_OPERATIONAL_SHA256: ${{ steps.release.outputs.release-operational-sha256 }}",
      "          AXIAL_RELEASE_OPERATIONAL_SHA256: ${{ steps.release.outputs.release-content-sha256 }}",
    ],
    [
      "          AXIAL_REPOSITORY: ${{ github.repository }}",
      "          AXIAL_REPOSITORY: fork/AxialMuseWebsite",
    ],
    [
      "          AXIAL_RUN_ID: ${{ github.run_id }}",
      "          AXIAL_RUN_ID: ${{ github.run_number }}",
    ],
    [
      "          AXIAL_RUN_ATTEMPT: ${{ github.run_attempt }}\n          AXIAL_COMMIT_SHA: ${{ github.sha }}",
      "          AXIAL_RUN_ATTEMPT: ${{ github.run_attempt }}\n          AXIAL_COMMIT_SHA: ${{ github.event.after }}",
    ],
    [
      "      repository: ${{ steps.identity.outputs.repository }}",
      "      repository: ${{ github.repository }}",
    ],
    [
      "      run-id: ${{ steps.identity.outputs.run-id }}",
      "      run-id: ${{ github.run_id }}",
    ],
    [
      "      run-attempt: ${{ steps.identity.outputs.run-attempt }}",
      "      run-attempt: ${{ github.run_attempt }}",
    ],
    [
      "      commit-sha: ${{ steps.identity.outputs.commit-sha }}",
      "      commit-sha: ${{ github.sha }}",
    ],
    [
      "        run: node scripts/quality/check-production-artifact-outputs.mjs",
      "        run: echo accepted",
    ],
  ]) {
    expectCode(
      replaceInJob(
        CANONICAL,
        "production-artifact",
        search,
        replacement,
      ),
      search.startsWith("      artifact-")
        || search.startsWith("      release-content")
        || search.startsWith("      repository")
        || search.startsWith("      run-")
        || search.startsWith("      commit-")
        ? "CI_WORKFLOW_JOB_SHAPE"
        : "CI_WORKFLOW_JOB_STEPS",
    );
  }
});

test("D-099 routine CI keeps static supply-chain evidence and excludes live audit", () => {
  expectCode(
    replaceOnce(
      CANONICAL,
      "node scripts/quality/check-supply-chain.mjs",
      "node --version",
    ),
    "CI_WORKFLOW_JOB_STEPS",
  );
  assert.equal(
    CANONICAL.includes("node scripts/quality/run-supply-chain-audit.mjs"),
    false,
  );
  expectCode(
    replaceInJob(
      CANONICAL,
      "supply-chain",
      "      - name: Static supply chain evidence",
      `      - name: Live dependency audit
        run: node scripts/quality/run-supply-chain-audit.mjs

      - name: Static supply chain evidence`,
    ),
    "CI_WORKFLOW_JOB_STEPS",
  );
});

test("D-097 failure bypass, matrix and conditional jobs are rejected", () => {
  for (const jobName of JOB_NAMES) {
    const timeout = `    timeout-minutes: ${JOB_TIMEOUTS[jobName]}`;
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        timeout,
        `${timeout}\n    continue-on-error: true`,
      ),
      "CI_WORKFLOW_FAILURE_BYPASS",
    );
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        timeout,
        `${timeout}\n    if: \${{ always() }}`,
      ),
      "CI_WORKFLOW_FAILURE_BYPASS",
    );
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        timeout,
        `${timeout}\n    if: github.ref == 'refs/heads/dev'`,
      ),
      "CI_WORKFLOW_FAILURE_BYPASS",
    );
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        timeout,
        `${timeout}\n    strategy:\n      matrix:\n        node: [24]`,
      ),
      "CI_WORKFLOW_MATRIX",
    );
  }
});

test("E-015 producer directly needs every prerequisite exactly once", () => {
  for (const [search, replacement] of [
    ["      - website-quality\n", ""],
    ["      - node-minimum\n", "      - website-quality\n"],
    ["      - diagrams\n", "      - supply-chain\n"],
    ["      - supply-chain\n", "      - deploy-production\n"],
  ]) {
    expectCode(
      replaceInJob(
        CANONICAL,
        "production-artifact",
        search,
        replacement,
      ),
      "CI_WORKFLOW_JOB_SHAPE",
    );
  }
  expectCode(
    replaceInJob(
      CANONICAL,
      "production-artifact",
      "    needs:",
      "    dependencies:",
    ),
    "CI_WORKFLOW_NEEDS",
  );
});

test("E-015 producer predicate allows only canonical main push", () => {
  const predicate = "    if: github.repository == 'lyty1997/AxialMuseWebsite' && github.event_name == 'push' && github.ref == 'refs/heads/main'";
  for (const replacement of [
    "    if: github.repository == 'fork/AxialMuseWebsite' && github.event_name == 'push' && github.ref == 'refs/heads/main'",
    "    if: github.repository == 'lyty1997/AxialMuseWebsite' && github.event_name == 'pull_request' && github.ref == 'refs/heads/main'",
    "    if: github.repository == 'lyty1997/AxialMuseWebsite' && github.event_name == 'push' && github.ref == 'refs/heads/dev'",
    "    if: github.repository == 'lyty1997/AxialMuseWebsite' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
    "    if: always()",
  ]) {
    expectCode(
      replaceInJob(
        CANONICAL,
        "production-artifact",
        predicate,
        replacement,
      ),
      "CI_WORKFLOW_FAILURE_BYPASS",
    );
  }
  expectCode(
    replaceOnce(
      CANONICAL,
      "on:\n  pull_request:",
      "on:\n  workflow_dispatch:\n  pull_request:",
    ),
    "CI_WORKFLOW_HEADER",
  );
});

test("D-097 producer jobs cannot receive environments, Secrets or write scopes", () => {
  for (const jobName of JOB_NAMES) {
    const timeout = `    timeout-minutes: ${JOB_TIMEOUTS[jobName]}`;
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        timeout,
        `${timeout}\n    environment: production`,
      ),
      "CI_WORKFLOW_EXTERNAL_STATE",
    );
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        `        run: ${JOB_RUN_COMMANDS[jobName]}`,
        "        run: echo ${{ secrets.CAM_SECRET }}",
      ),
      "CI_WORKFLOW_EXTERNAL_STATE",
    );
  }
  expectCode(
    replaceOnce(CANONICAL, "  contents: read", "  contents: write"),
    "CI_WORKFLOW_HEADER",
  );
});

test("CODE-020 prerequisite jobs cannot upload and no job can download", () => {
  for (const jobName of PREREQUISITE_JOB_NAMES) {
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        JOB_ANCHORS[jobName],
        `      - name: Upload\n        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n\n${JOB_ANCHORS[jobName]}`,
      ),
      "CI_WORKFLOW_ACTION_SET",
    );
  }
  for (const jobName of JOB_NAMES) {
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        JOB_ANCHORS[jobName],
        `      - name: Download\n        uses: actions/download-artifact@0000000000000000000000000000000000000000\n\n${JOB_ANCHORS[jobName]}`,
      ),
      "CI_WORKFLOW_ARTIFACT",
    );
  }
});

test("D-097 timeout and private runtime materialization are mandatory", () => {
  for (const jobName of JOB_NAMES) {
    const replacement = JOB_TIMEOUTS[jobName] === 60 ? 61 : 60;
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        `    timeout-minutes: ${JOB_TIMEOUTS[jobName]}`,
        `    timeout-minutes: ${replacement}`,
      ),
      "CI_WORKFLOW_JOB_SHAPE",
    );
  }
  for (const jobName of PRIVATE_RUNTIME_JOB_NAMES) {
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        "          umask 077",
        "          umask 022",
      ),
      "CI_WORKFLOW_JOB_STEPS",
    );
  }
});

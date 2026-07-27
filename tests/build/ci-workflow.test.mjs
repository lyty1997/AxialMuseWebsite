import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {
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
]);
const BUILD_JOB_NAMES = Object.freeze([
  "website-quality",
  "node-minimum",
]);
const PRIMARY_NODE_JOB_NAMES = Object.freeze([
  "website-quality",
  "diagrams",
  "supply-chain",
]);
const PRIVATE_RUNTIME_JOB_NAMES = Object.freeze([
  "website-quality",
  "node-minimum",
  "supply-chain",
]);
const JOB_ANCHORS = Object.freeze({
  "website-quality": "      - name: Frozen dependency install",
  "node-minimum": "      - name: Frozen dependency install",
  diagrams: "      - name: Set up Java",
  "supply-chain": "      - name: Static supply chain evidence",
});
const JOB_TIMEOUTS = Object.freeze({
  "website-quality": 45,
  "node-minimum": 45,
  diagrams: 15,
  "supply-chain": 20,
});
const JOB_RUN_COMMANDS = Object.freeze({
  "website-quality": "node scripts/quality/run-isolated-npm.mjs ci",
  "node-minimum": "node scripts/quality/run-isolated-npm.mjs ci",
  diagrams: "node scripts/quality/check-diagrams.mjs",
  "supply-chain": "node scripts/quality/check-supply-chain.mjs",
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

test("D-097 canonical CI topology passes with four jobs and pinned Actions", () => {
  assert.deepEqual(checkCiWorkflowSource(CANONICAL), {
    actionCount: 9,
    jobCount: 4,
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

test("D-097 isolated install and all four shared workloads are mandatory", () => {
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

test("D-097 first-stage CI cannot upload or download artifacts", () => {
  for (const jobName of JOB_NAMES) {
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        JOB_ANCHORS[jobName],
        `      - name: Upload\n        uses: actions/upload-artifact@0000000000000000000000000000000000000000\n\n${JOB_ANCHORS[jobName]}`,
      ),
      "CI_WORKFLOW_ARTIFACT",
    );
  }
});

test("D-097 timeout and private runtime materialization are mandatory", () => {
  for (const jobName of JOB_NAMES) {
    expectCode(
      replaceInJob(
        CANONICAL,
        jobName,
        `    timeout-minutes: ${JOB_TIMEOUTS[jobName]}`,
        "    timeout-minutes: 60",
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

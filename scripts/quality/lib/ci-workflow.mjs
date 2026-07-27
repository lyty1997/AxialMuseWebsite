import {readFileSync, realpathSync} from "node:fs";
import {join, resolve} from "node:path";

export const CI_ACTIONS = Object.freeze({
  checkout: Object.freeze({
    reference: "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
    version: "v5.1.0",
  }),
  setupJava: Object.freeze({
    reference: "actions/setup-java@03ad4de0992f5dab5e18fcb136590ce7c4a0ac95",
    version: "v5.6.0",
  }),
  setupNode: Object.freeze({
    reference: "actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444",
    version: "v5.0.0",
  }),
});

const HEADER = `name: CI

on:
  pull_request:
  push:
    branches:
      - main
      - dev

concurrency:
  group: ci-\${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
`;

const MATERIALIZE_PRIVATE_NODE_STEP = `      - name: Materialize private Node runtime
        shell: bash
        run: |
          set -euo pipefail
          umask 077
          source_node="$(readlink -f "$(command -v node)")"
          source_bin="\${source_node%/*}"
          source_prefix="\${source_bin%/*}"
          source_parent="\${source_prefix%/*}"
          source_root="\${source_parent%/*}"
          tool_cache="$(readlink -f "\${RUNNER_TOOL_CACHE}")"
          runner_temp="$(readlink -f "\${RUNNER_TEMP}")"
          target_prefix="\${runner_temp}/axial-muse-node-runtime"
          if [[ "\${source_node}" != "\${source_prefix}/bin/node" ]]; then
            echo "Current Node executable is not rooted in its distribution prefix." >&2
            exit 1
          fi
          if [[ "\${source_root}" != "\${tool_cache}/node" ]]; then
            echo "Current Node distribution is outside RUNNER_TOOL_CACHE/node." >&2
            exit 1
          fi
          if [[ -e "\${target_prefix}" ]]; then
            echo "Private Node runtime target already exists." >&2
            exit 1
          fi
          mkdir --mode=700 -- "\${target_prefix}"
          cp -R -- "\${source_prefix}/." "\${target_prefix}/"
          chmod -R go-w -- "\${target_prefix}"
          printf '%s\\n' "\${target_prefix}/bin" >> "\${GITHUB_PATH}"`;

function actionStep(name, action, withLines) {
  return [
    `      - name: ${name}`,
    `        uses: ${action.reference} # ${action.version}`,
    "        with:",
    ...withLines.map((line) => `          ${line}`),
  ].join("\n");
}

const FULL_CHECKOUT_STEP = actionStep(
  "Checkout full history",
  CI_ACTIONS.checkout,
  [
    "fetch-depth: 0",
    "persist-credentials: false",
  ],
);

const SHALLOW_CHECKOUT_STEP = actionStep(
  "Checkout",
  CI_ACTIONS.checkout,
  [
    "fetch-depth: 1",
    "persist-credentials: false",
  ],
);

const PRIMARY_NODE_STEP = actionStep(
  "Set up primary Node",
  CI_ACTIONS.setupNode,
  [
    "node-version-file: \".nvmrc\"",
    "package-manager-cache: false",
  ],
);

const MINIMUM_NODE_STEP = actionStep(
  "Set up minimum Node",
  CI_ACTIONS.setupNode,
  [
    "node-version: \"24.16.0\"",
    "package-manager-cache: false",
  ],
);

const ASSERT_PRIMARY_NODE_STEP = `      - name: Assert primary Node runtime
        run: |
          node -e '
            const {readFileSync} = require("node:fs");
            if (readFileSync(".nvmrc", "utf8") !== process.versions.node + "\\n") {
              throw new Error("Current Node does not exactly match .nvmrc.");
            }
          '`;

const JAVA_STEP = actionStep(
  "Set up Java",
  CI_ACTIONS.setupJava,
  [
    "distribution: temurin",
    "java-version: \"21\"",
  ],
);

const DOWNLOAD_PLANTUML_STEP = `      - name: Download pinned plantuml.jar
        run: |
          curl -sSL -o plantuml.jar \\
            "https://github.com/plantuml/plantuml/releases/download/v\${PUML_VERSION}/plantuml-\${PUML_VERSION}.jar"
          echo "\${PUML_SHA256}  plantuml.jar" | sha256sum -c -`;

function runStep(name, command, environmentLines = []) {
  return [
    `      - name: ${name}`,
    `        run: ${command}`,
    ...(environmentLines.length === 0
      ? []
      : [
        "        env:",
        ...environmentLines.map((line) => `          ${line}`),
      ]),
  ].join("\n");
}

const JOBS = Object.freeze({
  "website-quality": Object.freeze({
    prefix: `  website-quality:
    name: Website quality gates
    runs-on: ubuntu-latest
    timeout-minutes: 45

    steps:`,
    steps: Object.freeze([
      FULL_CHECKOUT_STEP,
      PRIMARY_NODE_STEP,
      MATERIALIZE_PRIVATE_NODE_STEP,
      runStep(
        "Frozen dependency install",
        "node scripts/quality/run-isolated-npm.mjs ci",
      ),
      runStep(
        "Quality gates",
        "node scripts/quality/run-isolated-npm.mjs run-script quality",
      ),
      runStep(
        "Type check",
        "node scripts/quality/run-isolated-npm.mjs run-script typecheck",
      ),
      runStep(
        "Tests",
        "node scripts/quality/run-isolated-npm.mjs run-script test",
      ),
      runStep(
        "Production build",
        "node scripts/quality/run-isolated-npm.mjs run-script build",
      ),
    ]),
  }),
  "node-minimum": Object.freeze({
    prefix: `  node-minimum:
    name: Minimum Node compatibility
    runs-on: ubuntu-latest
    timeout-minutes: 45

    steps:`,
    steps: Object.freeze([
      FULL_CHECKOUT_STEP,
      MINIMUM_NODE_STEP,
      MATERIALIZE_PRIVATE_NODE_STEP,
      runStep(
        "Frozen dependency install",
        "node scripts/quality/run-isolated-npm.mjs ci",
      ),
      runStep(
        "Quality gates",
        "node scripts/quality/run-isolated-npm.mjs run-script quality",
      ),
      runStep(
        "Type check",
        "node scripts/quality/run-isolated-npm.mjs run-script typecheck",
      ),
      runStep(
        "Tests",
        "node scripts/quality/run-isolated-npm.mjs run-script test",
      ),
      runStep(
        "Production build",
        "node scripts/quality/run-isolated-npm.mjs run-script build",
      ),
    ]),
  }),
  diagrams: Object.freeze({
    prefix: `  diagrams:
    name: Diagram compile check
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      PUML_VERSION: "1.2026.1"
      PUML_SHA256: "89c116168a2a0f7cf5292e11617ba22abd743f891914f1fec5bc9c7d257b3092"

    steps:`,
    steps: Object.freeze([
      SHALLOW_CHECKOUT_STEP,
      PRIMARY_NODE_STEP,
      ASSERT_PRIMARY_NODE_STEP,
      JAVA_STEP,
      DOWNLOAD_PLANTUML_STEP,
      runStep(
        "Check diagrams compile",
        "node scripts/quality/check-diagrams.mjs",
        ["PUML_JAR: \${{ github.workspace }}/plantuml.jar"],
      ),
    ]),
  }),
  "supply-chain": Object.freeze({
    prefix: `  supply-chain:
    name: Supply chain evidence
    runs-on: ubuntu-latest
    timeout-minutes: 20

    steps:`,
    steps: Object.freeze([
      SHALLOW_CHECKOUT_STEP,
      PRIMARY_NODE_STEP,
      MATERIALIZE_PRIVATE_NODE_STEP,
      runStep(
        "Static supply chain evidence",
        "node scripts/quality/check-supply-chain.mjs",
      ),
    ]),
  }),
});

const JOB_ORDER = Object.freeze([
  "website-quality",
  "node-minimum",
  "diagrams",
  "supply-chain",
]);

const FORBIDDEN_PATTERNS = Object.freeze([
  Object.freeze({
    code: "CI_WORKFLOW_FAILURE_BYPASS",
    pattern: /(?:^|\n)\s*(?:continue-on-error|if)\s*:/u,
  }),
  Object.freeze({
    code: "CI_WORKFLOW_FAILURE_BYPASS",
    pattern: /\balways\s*\(/u,
  }),
  Object.freeze({
    code: "CI_WORKFLOW_MATRIX",
    pattern: /(?:^|\n)\s*(?:strategy|matrix|needs)\s*:/u,
  }),
  Object.freeze({
    code: "CI_WORKFLOW_EXTERNAL_STATE",
    pattern: /(?:^|\n)\s*environment\s*:/u,
  }),
  Object.freeze({
    code: "CI_WORKFLOW_EXTERNAL_STATE",
    pattern: /\bsecrets\./u,
  }),
  Object.freeze({
    code: "CI_WORKFLOW_PERMISSION",
    pattern: /(?:^|\n)\s*(?:id-token|actions|attestations|deployments)\s*:/u,
  }),
  Object.freeze({
    code: "CI_WORKFLOW_CACHE",
    pattern: /\bactions\/cache@|\bcache-dependency-path\s*:|\bcache\s*:\s*(?:npm|yarn|pnpm)/u,
  }),
  Object.freeze({
    code: "CI_WORKFLOW_ARTIFACT",
    pattern: /\bactions\/(?:upload|download)-artifact@/u,
  }),
]);

export class CiWorkflowError extends Error {
  constructor(code) {
    super("CI workflow 契约检查失败。");
    this.name = "CiWorkflowError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

function fail(code) {
  throw new CiWorkflowError(code);
}

function splitWorkflow(source) {
  if (
    typeof source !== "string"
    || source.length === 0
    || !source.endsWith("\n")
    || source.includes("\r")
    || source.includes("\t")
    || source.includes("\0")
  ) {
    fail("CI_WORKFLOW_TEXT");
  }
  return source.slice(0, -1).split("\n");
}

function extractJobs(lines) {
  const jobsIndexes = lines.flatMap((line, index) => (
    line === "jobs:" ? [index] : []
  ));
  if (jobsIndexes.length !== 1) fail("CI_WORKFLOW_JOBS");
  const jobsIndex = jobsIndexes[0];
  const prefix = lines.slice(0, jobsIndex).join("\n").trimEnd();
  if (prefix !== HEADER.trimEnd()) fail("CI_WORKFLOW_HEADER");

  const headers = lines.slice(jobsIndex + 1).flatMap((line, offset) => {
    const match = /^  ([a-z][a-z0-9-]*):$/u.exec(line);
    return match === null
      ? []
      : [{index: jobsIndex + 1 + offset, name: match[1]}];
  });
  if (
    headers.length !== JOB_ORDER.length
    || headers.some((header, index) => header.name !== JOB_ORDER[index])
  ) {
    fail("CI_WORKFLOW_JOBS");
  }
  return new Map(headers.map((header, index) => {
    const end = headers[index + 1]?.index ?? lines.length;
    return [header.name, lines.slice(header.index, end)];
  }));
}

function extractSteps(jobLines, jobName) {
  const stepStarts = jobLines.flatMap((line, index) => (
    /^      - name: .+$/u.test(line) ? [index] : []
  ));
  if (stepStarts.length === 0) fail("CI_WORKFLOW_JOB_STEPS");
  const prefix = jobLines.slice(0, stepStarts[0]).join("\n").trimEnd();
  if (prefix !== JOBS[jobName].prefix) fail("CI_WORKFLOW_JOB_SHAPE");
  return stepStarts.map((start, index) => {
    const end = stepStarts[index + 1] ?? jobLines.length;
    return jobLines.slice(start, end).join("\n").trimEnd();
  });
}

function assertActionPins(source) {
  const references = source.split("\n").flatMap((line) => {
    const match = /^\s+uses: ([^ #]+)(?: # ([A-Za-z0-9.-]+))?$/u.exec(line);
    if (match === null) return [];
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u.test(match[1])) {
      fail("CI_WORKFLOW_ACTION_PIN");
    }
    return [Object.freeze({reference: match[1], version: match[2] ?? ""})];
  });
  const expected = [
    ...Array.from({length: 4}, () => CI_ACTIONS.checkout),
    ...Array.from({length: 4}, () => CI_ACTIONS.setupNode),
    CI_ACTIONS.setupJava,
  ];
  if (references.length !== expected.length) fail("CI_WORKFLOW_ACTION_SET");
  const counts = new Map();
  for (const action of references) {
    const identity = `${action.reference}#${action.version}`;
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  for (const action of expected) {
    const identity = `${action.reference}#${action.version}`;
    const remaining = counts.get(identity) ?? 0;
    if (remaining === 0) fail("CI_WORKFLOW_ACTION_SET");
    counts.set(identity, remaining - 1);
  }
  if ([...counts.values()].some((count) => count !== 0)) {
    fail("CI_WORKFLOW_ACTION_SET");
  }
}

export function checkCiWorkflowSource(source) {
  const lines = splitWorkflow(source);
  for (const {code, pattern} of FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) fail(code);
  }
  assertActionPins(source);
  const jobs = extractJobs(lines);
  for (const jobName of JOB_ORDER) {
    const actualSteps = extractSteps(jobs.get(jobName), jobName);
    const expectedSteps = JOBS[jobName].steps;
    if (
      actualSteps.length !== expectedSteps.length
      || actualSteps.some((step, index) => step !== expectedSteps[index])
    ) {
      fail("CI_WORKFLOW_JOB_STEPS");
    }
  }
  return Object.freeze({
    actionCount: 9,
    jobCount: JOB_ORDER.length,
  });
}

export function checkCiWorkflow(root) {
  if (typeof root !== "string" || !isAbsoluteRoot(root)) {
    fail("CI_WORKFLOW_ROOT");
  }
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    fail("CI_WORKFLOW_ROOT");
  }
  if (canonicalRoot !== root) fail("CI_WORKFLOW_ROOT");
  const path = join(root, ".github", "workflows", "ci.yml");
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    fail("CI_WORKFLOW_FILE");
  }
  return checkCiWorkflowSource(source);
}

function isAbsoluteRoot(root) {
  return resolve(root) === root;
}

export function formatCiWorkflowError(error) {
  const code = error instanceof CiWorkflowError
    && /^[A-Z][A-Z0-9_]{1,127}$/u.test(error.code)
    ? error.code
    : "CI_WORKFLOW_INTERNAL";
  return `[${code}] CI workflow 契约未通过。`;
}

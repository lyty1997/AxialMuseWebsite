import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {
  checkDeployProductionFixture,
  DEPLOY_CONCURRENCY_FIXTURE_PATH,
  DEPLOY_PRODUCTION_JOB,
  DEPLOY_SAFE_CI_CONCURRENCY,
  DEPLOY_WORKFLOW_FIXTURE_PATH,
  DeployWorkflowError,
  validateDeploySafeCiConcurrency,
  validateDeployProductionJob,
} from "../../scripts/quality/lib/deploy-workflow.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");

function expectCode(source, code) {
  assert.throws(
    () => validateDeployProductionJob(source),
    (error) => (
      error instanceof DeployWorkflowError
      && error.code === code
      && error.stack === undefined
    ),
  );
}

function expectConcurrencyCode(source, code) {
  assert.throws(
    () => validateDeploySafeCiConcurrency(source),
    (error) => (
      error instanceof DeployWorkflowError
      && error.code === code
      && error.stack === undefined
    ),
  );
}

test("#34 static deploy job fixture is exact but remains outside active workflows", () => {
  assert.deepEqual(checkDeployProductionFixture({root: ROOT}), {ok: true});
  assert.equal(
    readFileSync(resolve(ROOT, DEPLOY_CONCURRENCY_FIXTURE_PATH), "utf8"),
    DEPLOY_SAFE_CI_CONCURRENCY,
  );
  assert.equal(
    readFileSync(resolve(ROOT, DEPLOY_WORKFLOW_FIXTURE_PATH), "utf8"),
    DEPLOY_PRODUCTION_JOB,
  );
  assert.equal(DEPLOY_CONCURRENCY_FIXTURE_PATH.startsWith(".github/workflows/"), false);
  assert.equal(DEPLOY_WORKFLOW_FIXTURE_PATH.startsWith(".github/workflows/"), false);
  assert.equal(
    readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8")
      .includes("\n  deploy-production:\n"),
    false,
  );
  const preSecretStep = DEPLOY_PRODUCTION_JOB.split(
    "      - name: Reverify identity and invoke fixed TAT command\n",
  )[0];
  assert.equal(preSecretStep.includes("secrets."), false);
  assert.equal(
    DEPLOY_PRODUCTION_JOB.includes(
      "run: node scripts/deploy/check-production-deploy-identity.mjs\n",
    ),
    true,
  );
});

test("#34 static CI concurrency keeps main runs alive while retaining branch cancellation", () => {
  assert.equal(
    DEPLOY_SAFE_CI_CONCURRENCY.includes(
      "cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
    ),
    true,
  );
  for (const [search, replacement] of [
    [
      "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}\n",
      "  cancel-in-progress: true\n",
    ],
    [
      "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}\n",
      "  cancel-in-progress: false\n",
    ],
    [
      "  group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}\n",
      "  group: production\n",
    ],
  ]) {
    expectConcurrencyCode(
      DEPLOY_SAFE_CI_CONCURRENCY.replace(search, replacement),
      "DEPLOY_CONCURRENCY_SHAPE",
    );
  }
  expectConcurrencyCode(
    DEPLOY_SAFE_CI_CONCURRENCY.replace(/\n$/u, ""),
    "DEPLOY_CONCURRENCY_TEXT",
  );
});

test("#34 fixture rejects broad permissions, wrong topology and dynamic target", () => {
  for (const [search, replacement] of [
    ["      contents: read\n", "      contents: write\n"],
    ["      actions: read\n", "      actions: write\n"],
    ["      actions: read\n", "      actions: read\n      id-token: write\n"],
    ["    needs: production-artifact\n", "    needs: website-quality\n"],
    ["    environment: production\n", "    environment: staging\n"],
    ["      group: production\n", "      group: production-${{ github.sha }}\n"],
    ["      cancel-in-progress: false\n", "      cancel-in-progress: true\n"],
    ["          AXIAL_TAT_COMMAND_ID: ${{ vars.AXIAL_TAT_COMMAND_ID }}\n", "          AXIAL_TAT_COMMAND_ID: cmd-hardcoded\n"],
    ["          AXIAL_TAT_INSTANCE_ID: ${{ vars.AXIAL_TAT_INSTANCE_ID }}\n", "          AXIAL_TAT_INSTANCE_ID: lhins-hardcoded\n"],
    ["          AXIAL_ARTIFACT_ID: ${{ needs.production-artifact.outputs.artifact-id }}\n", "          AXIAL_ARTIFACT_ID: latest\n"],
  ]) {
    expectCode(
      DEPLOY_PRODUCTION_JOB.replace(search, replacement),
      "DEPLOY_WORKFLOW_SHAPE",
    );
  }
});

test("#34 fixture rejects skip, retry bypass, arbitrary command and download paths", () => {
  for (const injected of [
    "    continue-on-error: true\n",
    "    if: always()\n",
    "    workflow_dispatch:\n",
    "    run: RunCommand\n",
    "    uses: actions/download-artifact@0123456789012345678901234567890123456789\n",
  ]) {
    expectCode(
      DEPLOY_PRODUCTION_JOB.replace("    steps:\n", `${injected}    steps:\n`),
      "DEPLOY_WORKFLOW_BYPASS",
    );
  }
});

test("#34 fixture rejects malformed text and candidate shape drift", () => {
  expectCode(DEPLOY_PRODUCTION_JOB.replace(/\n$/u, ""), "DEPLOY_WORKFLOW_TEXT");
  expectCode(DEPLOY_PRODUCTION_JOB.replace(/\n/g, "\r\n"), "DEPLOY_WORKFLOW_TEXT");
  expectCode(`${DEPLOY_PRODUCTION_JOB}\n`, "DEPLOY_WORKFLOW_SHAPE");
});

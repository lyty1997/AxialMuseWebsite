import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {projectRoot} from "./files.mjs";
import {CI_ACTIONS} from "./ci-workflow.mjs";

const ROOT = projectRoot();
export const DEPLOY_WORKFLOW_FIXTURE_PATH = "tests/fixtures/deploy-production-job.yml";
export const DEPLOY_CONCURRENCY_FIXTURE_PATH = "tests/fixtures/deploy-production-concurrency.yml";

export const DEPLOY_SAFE_CI_CONCURRENCY = `concurrency:
  group: ci-\${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: \${{ github.ref != 'refs/heads/main' }}
`;

export const DEPLOY_PRODUCTION_JOB = `  deploy-production:
    name: Deploy production
    needs: production-artifact
    if: github.repository == 'lyty1997/AxialMuseWebsite' && github.event_name == 'push' && github.ref == 'refs/heads/main'
    permissions:
      contents: read
      actions: read
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: production
    concurrency:
      group: production
      cancel-in-progress: false

    steps:
      - name: Checkout exact production commit
        uses: ${CI_ACTIONS.checkout.reference} # ${CI_ACTIONS.checkout.version}
        with:
          ref: \${{ github.sha }}
          fetch-depth: 1
          persist-credentials: false

      - name: Set up primary Node
        uses: ${CI_ACTIONS.setupNode.reference} # ${CI_ACTIONS.setupNode.version}
        with:
          node-version-file: ".nvmrc"
          package-manager-cache: false

      - name: Verify production deploy identity before CAM Secret access
        env:
          AXIAL_WORKFLOW_RUN_ID: \${{ needs.production-artifact.outputs.run-id }}
          AXIAL_ARTIFACT_ID: \${{ needs.production-artifact.outputs.artifact-id }}
          AXIAL_COMMIT_SHA: \${{ needs.production-artifact.outputs.commit-sha }}
          AXIAL_ARTIFACT_DIGEST: \${{ needs.production-artifact.outputs.artifact-digest }}
          AXIAL_RELEASE_CONTENT_SHA256: \${{ needs.production-artifact.outputs.release-content-sha256 }}
          AXIAL_REPOSITORY: \${{ needs.production-artifact.outputs.repository }}
          AXIAL_RUN_ATTEMPT: \${{ needs.production-artifact.outputs.run-attempt }}
          AXIAL_GITHUB_TOKEN: \${{ github.token }}
        run: node scripts/deploy/check-production-deploy-identity.mjs

      - name: Reverify identity and invoke fixed TAT command
        env:
          AXIAL_WORKFLOW_RUN_ID: \${{ needs.production-artifact.outputs.run-id }}
          AXIAL_ARTIFACT_ID: \${{ needs.production-artifact.outputs.artifact-id }}
          AXIAL_COMMIT_SHA: \${{ needs.production-artifact.outputs.commit-sha }}
          AXIAL_ARTIFACT_DIGEST: \${{ needs.production-artifact.outputs.artifact-digest }}
          AXIAL_RELEASE_CONTENT_SHA256: \${{ needs.production-artifact.outputs.release-content-sha256 }}
          AXIAL_REPOSITORY: \${{ needs.production-artifact.outputs.repository }}
          AXIAL_RUN_ATTEMPT: \${{ needs.production-artifact.outputs.run-attempt }}
          AXIAL_GITHUB_TOKEN: \${{ github.token }}
          AXIAL_TAT_REGION: \${{ vars.AXIAL_TAT_REGION }}
          AXIAL_TAT_COMMAND_ID: \${{ vars.AXIAL_TAT_COMMAND_ID }}
          AXIAL_TAT_INSTANCE_ID: \${{ vars.AXIAL_TAT_INSTANCE_ID }}
          TENCENTCLOUD_SECRET_ID: \${{ secrets.TENCENTCLOUD_SECRET_ID }}
          TENCENTCLOUD_SECRET_KEY: \${{ secrets.TENCENTCLOUD_SECRET_KEY }}
        run: node scripts/deploy/dispatch-production.mjs
`;

export class DeployWorkflowError extends Error {
  constructor(code) {
    super("deploy-production workflow fixture 检查失败。");
    this.name = "DeployWorkflowError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: undefined,
      writable: false,
    });
  }
}

function fail(code) {
  throw new DeployWorkflowError(code);
}

export function validateDeployProductionJob(source) {
  if (
    typeof source !== "string"
    || source.length === 0
    || !source.endsWith("\n")
    || source.includes("\r")
    || source.includes("\t")
    || source.includes("\0")
  ) {
    fail("DEPLOY_WORKFLOW_TEXT");
  }
  if (
    /\balways\s*\(|continue-on-error\s*:|workflow_dispatch\s*:|RunCommand|actions\/download-artifact@/u.test(source)
  ) {
    fail("DEPLOY_WORKFLOW_BYPASS");
  }
  if (source !== DEPLOY_PRODUCTION_JOB) {
    fail("DEPLOY_WORKFLOW_SHAPE");
  }
  return Object.freeze({ok: true});
}

export function validateDeploySafeCiConcurrency(source) {
  if (
    typeof source !== "string"
    || source.length === 0
    || !source.endsWith("\n")
    || source.includes("\r")
    || source.includes("\t")
    || source.includes("\0")
  ) {
    fail("DEPLOY_CONCURRENCY_TEXT");
  }
  if (source !== DEPLOY_SAFE_CI_CONCURRENCY) {
    fail("DEPLOY_CONCURRENCY_SHAPE");
  }
  return Object.freeze({ok: true});
}

export function checkDeployProductionFixture({
  root = ROOT,
  readFile = readFileSync,
} = {}) {
  let concurrencySource;
  let jobSource;
  try {
    concurrencySource = readFile(
      resolve(root, DEPLOY_CONCURRENCY_FIXTURE_PATH),
      "utf8",
    );
    jobSource = readFile(resolve(root, DEPLOY_WORKFLOW_FIXTURE_PATH), "utf8");
  } catch {
    fail("DEPLOY_WORKFLOW_FILE");
  }
  validateDeploySafeCiConcurrency(concurrencySource);
  validateDeployProductionJob(jobSource);
  return Object.freeze({ok: true});
}

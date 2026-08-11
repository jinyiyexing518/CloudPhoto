import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyDeploymentEvent,
  classifyDeploymentStarted,
} from "./classify-deployment-event.mjs";
import {
  checkDeploymentOwnership,
  checkCurrentMainOwnership,
  classifyFrontendDeploymentJob,
  parseDeploymentMarker,
} from "./check-frontend-deployment-ownership.mjs";
import {
  checkWorkflowRuntimeContracts,
  inspectWorkflow,
} from "./check-workflow-runtime-contracts.mjs";

test("reads active workflow steps and ignores comments and run script text", () => {
  const inspected = inspectWorkflow(`
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Setup
        uses: actions/setup-node@v7
        with:
          node-version: "24"
          # node-version: "20"
      - name: Login
        uses: azure/login@v3
        # uses: azure/login@v2
      # - name: Removed login
      #   uses: azure/login@v3
      - name: Misleading shell text
        run: |
          echo "uses: azure/login@v3"
          echo "run: node scripts/check-workflow-runtime-contracts.mjs"
      - name: Enforce
        run: node scripts/check-workflow-runtime-contracts.mjs
      # - name: Removed enforcement
      #   run: node scripts/check-workflow-runtime-contracts.mjs
`, ".github/workflows/example.yml");

  assert.deepEqual(inspected.azureLoginRefs, [
    { path: ".github/workflows/example.yml", version: "v3" },
  ]);
  assert.deepEqual(inspected.setupNodeVersions, [
    { path: ".github/workflows/example.yml", actionVersion: "v7", version: "24" },
  ]);
  assert.deepEqual(inspected.contractInvocations, [
    ".github/workflows/example.yml",
  ]);
  assert.deepEqual(inspected.checkoutFetchDepths, []);
  assert.ok(inspected.runCommands.includes("node scripts/check-workflow-runtime-contracts.mjs"));
});

test("reports active deprecated action and runtime values", () => {
  const inspected = inspectWorkflow(`
jobs:
  deploy:
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: 20
      - uses: azure/login@v2
`, "deprecated.yml");

  assert.deepEqual(inspected.azureLoginRefs, [
    { path: "deprecated.yml", version: "v2" },
  ]);
  assert.deepEqual(inspected.setupNodeVersions, [
    { path: "deprecated.yml", actionVersion: "v5", version: "20" },
  ]);
});

test("reads active top-level concurrency and ignores comments and run script text", () => {
  const inspected = inspectWorkflow(`
concurrency:
  group: production-health-\${{ github.event_name == 'workflow_run' && github.event.workflow_run.conclusion != 'success' && format('failure-{0}', github.event.workflow_run.id) || 'latest' }}
  cancel-in-progress: true
# concurrency:
#   group: ignored
#   cancel-in-progress: false
jobs:
  smoke:
    steps:
      - name: Misleading shell text
        run: |
          echo "concurrency:"
          echo "  cancel-in-progress: false"
`, ".github/workflows/production-health.yml");

  assert.deepEqual(inspected.concurrency, {
    group: "production-health-${{ github.event_name == 'workflow_run' && github.event.workflow_run.conclusion != 'success' && format('failure-{0}', github.event.workflow_run.id) || 'latest' }}",
    cancelInProgress: "true",
  });
});

test("rejects a shared health group that could hide a failed deployment", () => {
  const result = checkWorkflowRuntimeContracts([
    {
      path: ".github/workflows/production-health.yml",
      text: `
concurrency:
  group: production-health
  cancel-in-progress: true
jobs:
  smoke:
    steps: []
`,
    },
  ]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("without hiding deployment failures")
    )
  );
});

test("rejects generic health runs that can cancel frontend SHA verification", () => {
  const path = ".github/workflows/production-health.yml";
  const health = readFileSync(
    new URL("../.github/workflows/production-health.yml", import.meta.url),
    "utf8"
  ).replace(
    "production-health-${{ github.event_name == 'workflow_run' && github.event.workflow_run.path == '.github/workflows/deploy-frontend.yml' && format('frontend-event-{0}-{1}', github.event.workflow_run.id, github.event.workflow_run.run_attempt) || github.event_name == 'workflow_run' && github.event.workflow_run.conclusion != 'success' && format('failure-{0}-{1}', github.event.workflow_run.id, github.event.workflow_run.run_attempt) || github.event_name == 'workflow_run' && github.event.workflow_run.path == '.github/workflows/deploy-backend.yml' && 'backend-deployment' || 'latest' }}",
    "production-health-${{ github.event_name == 'workflow_run' && github.event.workflow_run.conclusion != 'success' && format('failure-{0}-{1}', github.event.workflow_run.id, github.event.workflow_run.run_attempt) || 'latest' }}"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: health }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("without hiding deployment failures")
    )
  );
});

test("rejects frontend events that share a health concurrency identity", () => {
  const path = ".github/workflows/production-health.yml";
  const health = readFileSync(
    new URL("../.github/workflows/production-health.yml", import.meta.url),
    "utf8"
  ).replace(
    "format('frontend-event-{0}-{1}', github.event.workflow_run.id, github.event.workflow_run.run_attempt)",
    "'frontend-deployment'"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: health }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("without hiding deployment failures")
    )
  );
});

test("rejects rerun failures that share a health concurrency identity", () => {
  const path = ".github/workflows/production-health.yml";
  const health = readFileSync(
    new URL("../.github/workflows/production-health.yml", import.meta.url),
    "utf8"
  ).replace(
    "format('failure-{0}-{1}', github.event.workflow_run.id, github.event.workflow_run.run_attempt)",
    "format('failure-{0}', github.event.workflow_run.id)"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: health }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("without hiding deployment failures")
    )
  );
});

test("rejects frontend nondeployment reruns that share a health concurrency identity", () => {
  const path = ".github/workflows/production-health.yml";
  const health = readFileSync(
    new URL("../.github/workflows/production-health.yml", import.meta.url),
    "utf8"
  ).replace(
    "format('frontend-event-{0}-{1}', github.event.workflow_run.id, github.event.workflow_run.run_attempt)",
    "format('frontend-event-{0}', github.event.workflow_run.id)"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: health }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("without hiding deployment failures")
    )
  );
});

test("rejects frontend production uploads without serialized production concurrency", () => {
  const result = checkWorkflowRuntimeContracts([
    {
      path: ".github/workflows/deploy-frontend.yml",
      text: `
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  build_and_deploy:
    steps:
      - uses: Azure/static-web-apps-deploy@v1
        with:
          action: upload
`,
    },
  ]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("serialize the production target")
    )
  );
});

test("requires deployment ownership and receipt gates beyond serialization", () => {
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  );

  for (const required of [
    "Check deployment ownership",
    "Recheck deployment ownership",
    "node scripts/check-frontend-deployment-ownership.mjs",
    "Record canonical deployment receipt",
    "node scripts/check-frontend-deployment-ownership.mjs --confirm-current-main",
    "Requeue current main tip",
    "gh workflow run deploy-frontend.yml --ref main -f mode=production",
  ]) {
    assert.match(frontend, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("rejects production concurrency without stale-main requeue recovery", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  ).replace(
    "      - name: Requeue current main tip after initial check",
    "      - name: Disabled current main tip requeue"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: frontend }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("requeue the current main tip")
    )
  );
});

test("rejects a serialized frontend workflow without final ownership coalescing", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  ).replace(
    "      - name: Recheck deployment ownership",
    "      - name: Disabled deployment ownership recheck"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: frontend }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("coalesce stale and duplicate production runs")
    )
  );
});

test("rejects a canonical receipt without an in-step main-tip fence", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  ).replace(
    "        run: node scripts/check-frontend-deployment-ownership.mjs --confirm-current-main",
    "        run: echo receipt-without-current-main-fence"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: frontend }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("main-tip-fenced deployment receipt")
    )
  );
});

test("final receipt ownership checks current main without coalescing on old receipts", async () => {
  const sha = "b".repeat(40);
  const result = await checkCurrentMainOwnership({
    expectedSha: sha,
    repository: "owner/repo",
    requestJson: async (path) => {
      assert.equal(path, "/repos/owner/repo/git/ref/heads/main");
      return { object: { sha } };
    },
  });

  assert.deepEqual(result, {
    reason: "owned",
    receiptRunAttempt: "",
    receiptRunId: "",
    shouldDeploy: true,
  });
});

test("rejects non-main manual frontend runs that can upload to production", () => {
  const result = checkWorkflowRuntimeContracts([
    {
      path: ".github/workflows/deploy-frontend.yml",
      text: `
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  build_and_deploy:
    steps:
      - uses: Azure/static-web-apps-deploy@v1
        with:
          action: upload
`,
    },
  ]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("non-main workflow_dispatch runs validation-only")
    )
  );
});

test("rejects the unsupported Static Web Apps production_branch input", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  ).replace(
    "          skip_app_build: true",
    "          production_branch: main\n          skip_app_build: true"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: frontend }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("must not pass the unsupported production_branch input")
    )
  );
});

test("rejects Node 20 artifact action majors when Node 24 releases exist", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  )
    .replace("actions/upload-artifact@v7", "actions/upload-artifact@v4")
    .replace("actions/download-artifact@v8", "actions/download-artifact@v4");
  const result = checkWorkflowRuntimeContracts([{ path, text: frontend }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("actions/upload-artifact@v7")
    )
  );
  assert.ok(
    result.issues.some((issue) =>
      issue.includes("actions/download-artifact@v8")
    )
  );
});

test("reads frontend dispatch and upload policy from active YAML only", () => {
  const inspected = inspectWorkflow(`
on:
  workflow_dispatch:
    inputs:
      mode:
        required: true
        default: validate
        type: choice
        options:
          - validate
          - production
concurrency:
  group: deploy-frontend-production
  cancel-in-progress: false
jobs:
  deploy:
    steps:
      - if: github.ref == 'refs/heads/main'
        uses: Azure/static-web-apps-deploy@v1
        with:
          azure_static_web_apps_api_token: \${{ steps.swa_token.outputs.deployment_token }}
          action: upload
      # - uses: Azure/static-web-apps-deploy@v1
      #   with:
      #     action: upload
`, ".github/workflows/deploy-frontend.yml");

  assert.deepEqual(inspected.workflowDispatchModes, ["validate", "production"]);
  assert.equal(inspected.workflowDispatchModeDefault, "validate");
  assert.equal(inspected.workflowDispatchModeRequired, "true");
  assert.equal(inspected.workflowDispatchModeType, "choice");
  assert.deepEqual(inspected.staticWebAppActions, [
    {
      action: "upload",
      path: ".github/workflows/deploy-frontend.yml",
      condition: "github.ref == 'refs/heads/main'",
      job: "deploy",
      productionBranch: null,
      ref: "v1",
      token: "${{ steps.swa_token.outputs.deployment_token }}",
    },
  ]);
  assert.equal(inspected.usesRepositorySwaToken, false);
});

test("locks frontend artifact casing, refs, paths, retention, and cross-job handoff", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  );
  const inspected = inspectWorkflow(frontend, path);

  assert.deepEqual(inspected.artifactActions, [
    {
      action: "upload-artifact",
      condition:
        "(github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.mode == 'production')",
      ifNoFilesFound: "error",
      job: "build",
      name: "frontend-dist",
      path: "packages/client/dist",
      ref: "v7",
      retentionDays: "1",
      stepName: "Stage production artifact",
      uses: "actions/upload-artifact@v7",
    },
    {
      action: "download-artifact",
      condition: null,
      ifNoFilesFound: null,
      job: "deploy_production",
      name: "frontend-dist",
      path: "packages/client/dist",
      ref: "v8",
      retentionDays: null,
      stepName: "Download production artifact",
      uses: "actions/download-artifact@v8",
    },
  ]);
  assert.deepEqual(inspected.frontendProductionJob, {
    actionsPermission: "write",
    condition:
      "(github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.mode == 'production')",
    needs: "build",
  });
  assert.equal(inspected.staticWebAppActions[0].productionBranch, null);
  assert.equal(inspected.staticWebAppActions[0].job, "deploy_production");
});

test("rejects artifact action casing or ref drift", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  )
    .replace("actions/upload-artifact@v7", "Actions/Upload-Artifact@v7")
    .replace("actions/download-artifact@v8", "actions/download-artifact@v7");
  const result = checkWorkflowRuntimeContracts([{ path, text: frontend }]);

  assert.ok(
    result.issues.some((issue) => issue.includes("actions/upload-artifact@v7"))
  );
  assert.ok(
    result.issues.some((issue) => issue.includes("actions/download-artifact@v8"))
  );
});

test("rejects deployment steps moved to the wrong jobs", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  );
  const uploadBlock = frontend.match(
    /      - name: Stage production artifact[\s\S]*?          retention-days: 1\n/
  )?.[0];
  const downloadBlock = frontend.match(
    /      - name: Download production artifact[\s\S]*?          path: packages\/client\/dist\n/
  )?.[0];
  assert.ok(uploadBlock);
  assert.ok(downloadBlock);

  const artifactJobsSwapped = frontend
    .replace(uploadBlock, "__UPLOAD_BLOCK__")
    .replace(downloadBlock, uploadBlock)
    .replace("__UPLOAD_BLOCK__", downloadBlock);
  const swaBlock = frontend.match(
    /      - name: Deploy to Azure Static Web Apps[\s\S]*$/
  )?.[0];
  assert.ok(swaBlock);
  const swaMovedToBuild = frontend
    .replace(swaBlock, "")
    .replace("  deploy_production:", `${swaBlock}\n  deploy_production:`);

  const artifactResult = checkWorkflowRuntimeContracts([
    { path, text: artifactJobsSwapped },
  ]);
  const swaResult = checkWorkflowRuntimeContracts([{ path, text: swaMovedToBuild }]);

  assert.ok(
    artifactResult.issues.some((issue) =>
      issue.includes("actions/upload-artifact@v7")
    )
  );
  assert.ok(
    artifactResult.issues.some((issue) =>
      issue.includes("actions/download-artifact@v8")
    )
  );
  assert.ok(
    swaResult.issues.some((issue) =>
      issue.includes("guard the production upload")
    )
  );
});

test("finds Static Web Apps actions regardless of ref or casing", () => {
  const inspected = inspectWorkflow(`
jobs:
  deploy:
    steps:
      - uses: azure/Static-Web-Apps-Deploy@0123456789abcdef
        with:
          azure_static_web_apps_api_token: \${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN }}
          action: upload
          production_branch: main
`, ".github/workflows/deploy-frontend.yml");

  assert.equal(inspected.staticWebAppActions.length, 1);
  assert.equal(inspected.staticWebAppActions[0].ref, "0123456789abcdef");
  assert.equal(inspected.staticWebAppActions[0].job, "deploy");
  assert.equal(inspected.staticWebAppActions[0].productionBranch, "main");
  assert.equal(inspected.usesRepositorySwaToken, true);
});

test("rejects an additional Static Web Apps action pinned to another ref", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  );
  const withShadowUpload = frontend.replace(
    "      - name: Deploy to Azure Static Web Apps",
    `      - name: Shadow production upload
        uses: azure/Static-Web-Apps-Deploy@0123456789abcdef
        with:
          azure_static_web_apps_api_token: \${{ steps.swa_token.outputs.deployment_token }}
          action: upload

      - name: Deploy to Azure Static Web Apps`
  );
  const result = checkWorkflowRuntimeContracts([
    { path, text: withShadowUpload },
  ]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("non-main workflow_dispatch runs validation-only")
    )
  );
});

test("rejects bracket-notation access to the legacy repository token", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  ).replace(
    "          SWA_DEFAULT_HOSTNAME: brave-sand-053b07a00.7.azurestaticapps.net",
    `          SWA_DEFAULT_HOSTNAME: brave-sand-053b07a00.7.azurestaticapps.net
          LEGACY_TOKEN: \${{ secrets['azure_static_web_apps_api_token'] }}`
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: frontend }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("non-main workflow_dispatch runs validation-only")
    )
  );
});

test("rejects production health without deployment-event classification", () => {
  const path = ".github/workflows/production-health.yml";
  const health = readFileSync(
    new URL("../.github/workflows/production-health.yml", import.meta.url),
    "utf8"
  ).replace("      - name: Classify deployment event", "      - name: Disabled classifier");
  const result = checkWorkflowRuntimeContracts([{ path, text: health }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("never started production deployment")
    )
  );
});

test("rejects production health that reads jobs from a different rerun attempt", () => {
  const path = ".github/workflows/production-health.yml";
  const health = readFileSync(
    new URL("../.github/workflows/production-health.yml", import.meta.url),
    "utf8"
  ).replace(
    "runs/$DEPLOYMENT_RUN_ID/attempts/$DEPLOYMENT_RUN_ATTEMPT/jobs?per_page=100",
    "runs/$DEPLOYMENT_RUN_ID/jobs?per_page=100"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: health }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("triggering workflow attempt")
    )
  );
});

test("rejects production health that reads jobs from the health workflow run", () => {
  const path = ".github/workflows/production-health.yml";
  const health = readFileSync(
    new URL("../.github/workflows/production-health.yml", import.meta.url),
    "utf8"
  ).replace(
    "DEPLOYMENT_RUN_ID: ${{ github.event.workflow_run.id }}",
    "DEPLOYMENT_RUN_ID: ${{ github.run_id }}"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: health }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("triggering workflow attempt")
    )
  );
});

test("rejects production health that checks out the current workflow SHA", () => {
  const path = ".github/workflows/production-health.yml";
  const health = readFileSync(
    new URL("../.github/workflows/production-health.yml", import.meta.url),
    "utf8"
  ).replace(
    "          ref: ${{ github.event.workflow_run.head_sha }}\n          path: .deployment",
    "          ref: ${{ github.sha }}\n          path: .deployment"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: health }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("triggering deployed SHA")
    )
  );
});

test("rejects production health that can silently accept missing classifier outputs", () => {
  const path = ".github/workflows/production-health.yml";
  const health = readFileSync(
    new URL("../.github/workflows/production-health.yml", import.meta.url),
    "utf8"
  ).replace(
    "      - name: Validate deployment classification",
    "      - name: Disabled deployment classification validation"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: health }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("fail closed when classifier outputs are missing")
    )
  );
});

test("rejects production health that does not validate the deployment receipt", () => {
  const path = ".github/workflows/production-health.yml";
  const health = readFileSync(
    new URL("../.github/workflows/production-health.yml", import.meta.url),
    "utf8"
  ).replace(
    "          DEPLOYMENT_RECEIPT: ${{ steps.deployment_event.outputs.deployment_receipt }}",
    "          DEPLOYMENT_RECEIPT: false"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: health }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("fail closed when classifier outputs are missing")
    )
  );
});

test("rejects production health without a controller-owned artifact identity gate", () => {
  const path = ".github/workflows/production-health.yml";
  const health = readFileSync(
    new URL("../.github/workflows/production-health.yml", import.meta.url),
    "utf8"
  ).replace(
    "      - name: Verify deployed artifact identity",
    "      - name: Disabled deployed artifact identity"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: health }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("controller-owned deployment marker gate")
    )
  );
});

test("rejects a health classifier command with success-only filtering", () => {
  const path = ".github/workflows/production-health.yml";
  const health = readFileSync(
    new URL("../.github/workflows/production-health.yml", import.meta.url),
    "utf8"
  ).replace(
    'node .health-control/scripts/classify-deployment-event.mjs --workflow "$DEPLOYMENT_WORKFLOW"',
    'jq \'.jobs |= map(select(.conclusion == "success"))\' | node .health-control/scripts/classify-deployment-event.mjs --workflow "$DEPLOYMENT_WORKFLOW"'
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: health }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("never started production deployment")
    )
  );
});

test("rejects mutable run-name as the deployment workflow identity", () => {
  const path = ".github/workflows/production-health.yml";
  const health = readFileSync(
    new URL("../.github/workflows/production-health.yml", import.meta.url),
    "utf8"
  ).replace(
    "DEPLOYMENT_WORKFLOW: ${{ github.event.workflow_run.path }}",
    "DEPLOYMENT_WORKFLOW: ${{ github.event.workflow_run.name }}"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: health }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("validation/coalesced frontend runs")
    )
  );
});

test("classifies an explicit Azure upload step as a frontend deployment attempt", () => {
  const workflow = ".github/workflows/deploy-frontend.yml";

  assert.equal(
    classifyDeploymentStarted(workflow, {
      jobs: [
        {
          name: "Deploy production",
          started_at: "2026-08-11T00:00:00Z",
          conclusion: "failure",
          steps: [
            { name: "Deploy to Azure Static Web Apps", conclusion: "failure" },
          ],
        },
      ],
    }),
    true
  );
  assert.equal(
    classifyDeploymentStarted(workflow, {
      jobs: [
        {
          name: "Deploy production",
          started_at: "2026-08-11T00:00:00Z",
          conclusion: "success",
          steps: [
            { name: "Deploy to Azure Static Web Apps", conclusion: "success" },
            { name: "Record canonical deployment receipt", conclusion: "success" },
          ],
        },
      ],
    }),
    true
  );
  assert.equal(
    classifyDeploymentStarted(workflow, {
      jobs: [
        {
          name: "Deploy production",
          started_at: null,
          conclusion: "skipped",
        },
      ],
    }),
    false
  );
  assert.equal(classifyDeploymentStarted(workflow, { jobs: [] }), false);
});

test("blocks an older SHA before querying prior deployment receipts", async () => {
  const requests = [];
  const result = await checkDeploymentOwnership({
    currentRunAttempt: "1",
    currentRunId: "22",
    expectedSha: "a".repeat(40),
    repository: "owner/repo",
    requestJson: async (path) => {
      requests.push(path);
      return { object: { sha: "b".repeat(40) } };
    },
  });

  assert.deepEqual(result, {
    reason: "stale-main",
    receiptRunAttempt: "",
    receiptRunId: "",
    shouldDeploy: false,
  });
  assert.deepEqual(requests, ["/repos/owner/repo/git/ref/heads/main"]);
});

test("coalesces a duplicate SHA with a successful canonical deployment receipt", async () => {
  const sha = "c".repeat(40);
  const requests = [];
  const result = await checkDeploymentOwnership({
    currentRunAttempt: "1",
    currentRunId: "42",
    expectedSha: sha,
    markerAttempts: 1,
    readDeploymentMarker: async () => sha,
    repository: "owner/repo",
    requestJson: async (path) => {
      requests.push(path);
      if (path.endsWith("/git/ref/heads/main")) {
        return { object: { sha } };
      }
      if (path.includes("/actions/workflows/deploy-frontend.yml/runs?")) {
        return {
          total_count: 1,
          workflow_runs: [{
            event: "push",
            head_branch: "main",
            head_sha: sha,
            id: 41,
            path: ".github/workflows/deploy-frontend.yml",
            run_attempt: 1,
          }],
        };
      }
      return {
        jobs: [{
          name: "Deploy production",
          started_at: "2026-08-11T00:00:00Z",
          conclusion: "success",
          steps: [
            { name: "Deploy to Azure Static Web Apps", conclusion: "success" },
            { name: "Record canonical deployment receipt", conclusion: "success" },
          ],
        }],
      };
    },
  });

  assert.deepEqual(result, {
    reason: "already-deployed",
    receiptRunAttempt: "1",
    receiptRunId: "41",
    shouldDeploy: false,
  });
  assert.ok(requests[1].includes("head_sha=cccccccccccccccccccccccccccccccccccccccc"));
  assert.ok(requests[1].includes("page=1"));
  assert.equal(
    requests[2],
    "/repos/owner/repo/actions/runs/41/attempts/1/jobs?per_page=100"
  );
});

test("does not treat a successful coalesced job as a deployment receipt", async () => {
  const sha = "d".repeat(40);
  const result = await checkDeploymentOwnership({
    currentRunAttempt: "1",
    currentRunId: "52",
    expectedSha: sha,
    markerAttempts: 1,
    readDeploymentMarker: async () => sha,
    repository: "owner/repo",
    requestJson: async (path) => {
      if (path.endsWith("/git/ref/heads/main")) {
        return { object: { sha } };
      }
      if (path.includes("/actions/workflows/deploy-frontend.yml/runs?")) {
        return {
          total_count: 1,
          workflow_runs: [{
            event: "workflow_dispatch",
            head_branch: "main",
            head_sha: sha,
            id: 51,
            path: ".github/workflows/deploy-frontend.yml",
            run_attempt: 2,
          }],
        };
      }
      return {
        jobs: [{
          name: "Deploy production",
          started_at: "2026-08-11T00:00:00Z",
          conclusion: "success",
          steps: [
            { name: "Deploy to Azure Static Web Apps", conclusion: "skipped" },
            { name: "Record canonical deployment receipt", conclusion: "skipped" },
          ],
        }],
      };
    },
  });

  assert.deepEqual(result, {
    reason: "owned",
    receiptRunAttempt: "",
    receiptRunId: "",
    shouldDeploy: true,
  });
});

test("coalesces a rerun against a successful receipt from its prior attempt", async () => {
  const sha = "e".repeat(40);
  const requests = [];
  const result = await checkDeploymentOwnership({
    currentRunAttempt: "2",
    currentRunId: "61",
    expectedSha: sha,
    markerAttempts: 1,
    readDeploymentMarker: async () => sha,
    repository: "owner/repo",
    requestJson: async (path) => {
      requests.push(path);
      if (path.endsWith("/git/ref/heads/main")) {
        return { object: { sha } };
      }
      return {
        jobs: [{
          name: "Deploy production",
          started_at: "2026-08-11T00:00:00Z",
          conclusion: "success",
          steps: [
            { name: "Deploy to Azure Static Web Apps", conclusion: "success" },
            { name: "Record canonical deployment receipt", conclusion: "success" },
          ],
        }],
      };
    },
  });

  assert.deepEqual(result, {
    reason: "already-deployed",
    receiptRunAttempt: "1",
    receiptRunId: "61",
    shouldDeploy: false,
  });
  assert.deepEqual(requests, [
    "/repos/owner/repo/git/ref/heads/main",
    "/repos/owner/repo/actions/runs/61/attempts/1/jobs?per_page=100",
  ]);
});

test("finds a receipt in an earlier attempt of another run", async () => {
  const sha = "5".repeat(40);
  const requestedAttempts = [];
  const result = await checkDeploymentOwnership({
    currentRunAttempt: "1",
    currentRunId: "102",
    expectedSha: sha,
    markerAttempts: 1,
    readDeploymentMarker: async () => sha,
    repository: "owner/repo",
    requestJson: async (path) => {
      if (path.endsWith("/git/ref/heads/main")) {
        return { object: { sha } };
      }
      if (path.includes("/actions/workflows/deploy-frontend.yml/runs?")) {
        return {
          total_count: 1,
          workflow_runs: [{
            conclusion: "failure",
            event: "push",
            head_branch: "main",
            head_sha: sha,
            id: 101,
            path: ".github/workflows/deploy-frontend.yml",
            run_attempt: 2,
          }],
        };
      }
      requestedAttempts.push(path);
      const receipt = path.includes("/attempts/1/");
      return {
        jobs: [{
          name: "Deploy production",
          started_at: "2026-08-11T00:00:00Z",
          conclusion: receipt ? "success" : "failure",
          steps: [
            {
              name: "Deploy to Azure Static Web Apps",
              conclusion: receipt ? "success" : "failure",
            },
            {
              name: "Record canonical deployment receipt",
              conclusion: receipt ? "success" : "skipped",
            },
          ],
        }],
      };
    },
  });

  assert.deepEqual(result, {
    reason: "already-deployed",
    receiptRunAttempt: "1",
    receiptRunId: "101",
    shouldDeploy: false,
  });
  assert.deepEqual(requestedAttempts, [
    "/repos/owner/repo/actions/runs/101/attempts/1/jobs?per_page=100",
  ]);
});

test("redeploys when a historical receipt no longer matches live production", async () => {
  const sha = "f".repeat(40);
  const result = await checkDeploymentOwnership({
    currentRunAttempt: "2",
    currentRunId: "71",
    expectedSha: sha,
    markerAttempts: 1,
    readDeploymentMarker: async () => "a".repeat(40),
    repository: "owner/repo",
    requestJson: async (path) => {
      if (path.endsWith("/git/ref/heads/main")) {
        return { object: { sha } };
      }
      return {
        jobs: [{
          name: "Deploy production",
          started_at: "2026-08-11T00:00:00Z",
          conclusion: "success",
          steps: [
            { name: "Deploy to Azure Static Web Apps", conclusion: "success" },
            { name: "Record canonical deployment receipt", conclusion: "success" },
          ],
        }],
      };
    },
  });

  assert.deepEqual(result, {
    reason: "deployment-drift",
    receiptRunAttempt: "1",
    receiptRunId: "71",
    shouldDeploy: true,
  });
});

test("paginates successful same-SHA runs before declaring ownership", async () => {
  const sha = "1".repeat(40);
  const requests = [];
  const result = await checkDeploymentOwnership({
    currentRunAttempt: "1",
    currentRunId: "82",
    expectedSha: sha,
    markerAttempts: 1,
    readDeploymentMarker: async () => sha,
    repository: "owner/repo",
    requestJson: async (path) => {
      requests.push(path);
      if (path.endsWith("/git/ref/heads/main")) {
        return { object: { sha } };
      }
      if (/[?&]page=1(?:&|$)/.test(path)) {
        return {
          total_count: 101,
          workflow_runs: Array.from({ length: 100 }, (_, index) => ({
            conclusion: "success",
            event: "push",
            head_branch: "main",
            head_sha: sha,
            id: 1_000 + index,
            path: ".github/workflows/old-frontend.yml",
            run_attempt: 1,
          })),
        };
      }
      if (/[?&]page=2(?:&|$)/.test(path)) {
        return {
          total_count: 101,
          workflow_runs: [{
            conclusion: "success",
            event: "push",
            head_branch: "main",
            head_sha: sha,
            id: 81,
            path: ".github/workflows/deploy-frontend.yml",
            run_attempt: 3,
          }],
        };
      }
      return {
        jobs: [{
          name: "Deploy production",
          started_at: "2026-08-11T00:00:00Z",
          conclusion: "success",
          steps: [
            { name: "Deploy to Azure Static Web Apps", conclusion: "success" },
            { name: "Record canonical deployment receipt", conclusion: "success" },
          ],
        }],
      };
    },
  });

  assert.deepEqual(result, {
    reason: "already-deployed",
    receiptRunAttempt: "1",
    receiptRunId: "81",
    shouldDeploy: false,
  });
  assert.ok(requests.some((path) => path.includes("page=2")));
});

test("fails closed when same-SHA history exceeds GitHub's filtered result cap", async () => {
  const sha = "3".repeat(40);
  await assert.rejects(() => checkDeploymentOwnership({
    currentRunAttempt: "1",
    currentRunId: "91",
    expectedSha: sha,
    markerAttempts: 1,
    readDeploymentMarker: async () => sha,
    repository: "owner/repo",
    requestJson: async (path) => {
      if (path.endsWith("/git/ref/heads/main")) {
        return { object: { sha } };
      }
      return { total_count: 1_001, workflow_runs: [] };
    },
  }), /1000-result limit/);
});

test("requires both the Azure upload and receipt step to succeed", () => {
  assert.deepEqual(classifyFrontendDeploymentJob({
    jobs: [{
      name: "Deploy production",
      started_at: "2026-08-11T00:00:00Z",
      conclusion: "success",
      steps: [
        { name: "Deploy to Azure Static Web Apps", conclusion: "success" },
        { name: "Record canonical deployment receipt", conclusion: "success" },
      ],
    }],
  }), {
    deploymentReceipt: true,
    deploymentStarted: true,
  });
});

test("accepts only an exact no-store deployment marker", () => {
  const sha = "2".repeat(40);
  assert.equal(parseDeploymentMarker({
    body: JSON.stringify({ sha }),
    cacheControl: "public, no-store",
    origin: "https://example.test",
  }), sha);
  assert.throws(() => parseDeploymentMarker({
    body: JSON.stringify({ sha }),
    cacheControl: "max-age=60",
    origin: "https://example.test",
  }), /cacheable/);
  assert.throws(() => parseDeploymentMarker({
    body: JSON.stringify({ sha, url: "https://example.test/private" }),
    cacheControl: "no-store",
    origin: "https://example.test",
  }), /invalid shape/);
  assert.throws(() => parseDeploymentMarker({
    body: JSON.stringify({ sha }),
    cacheControl: "max-age=3600, x-no-store-cache=true",
    origin: "https://example.test",
  }), /cacheable/);
});

test("ignores a serialized frontend job that skipped the Azure upload", () => {
  const workflow = ".github/workflows/deploy-frontend.yml";
  const jobs = [{
    name: "Deploy production",
    started_at: "2026-08-11T00:00:00Z",
    conclusion: "success",
    steps: [
      { name: "Deploy to Azure Static Web Apps", conclusion: "skipped" },
      { name: "Record canonical deployment receipt", conclusion: "skipped" },
    ],
  }];

  assert.equal(classifyDeploymentStarted(workflow, { jobs }), false);
  assert.deepEqual(classifyDeploymentEvent({
    workflowName: workflow,
    workflowEvent: "push",
    headBranch: "main",
    headSha: "a".repeat(40),
    conclusion: "success",
    jobs,
  }), {
    canonicalDeployment: false,
    deployedSha: "a".repeat(40),
    deploymentReceipt: false,
    deploymentStarted: false,
    shouldCheck: false,
    shouldReject: false,
  });
});

test("fails closed when Azure upload succeeds without a canonical receipt", () => {
  const result = classifyDeploymentEvent({
    workflowName: ".github/workflows/deploy-frontend.yml",
    workflowEvent: "push",
    headBranch: "main",
    headSha: "b".repeat(40),
    conclusion: "success",
    jobs: [{
      name: "Deploy production",
      started_at: "2026-08-11T00:00:00Z",
      conclusion: "success",
      steps: [
        { name: "Deploy to Azure Static Web Apps", conclusion: "success" },
        { name: "Record canonical deployment receipt", conclusion: "skipped" },
      ],
    }],
  });

  assert.deepEqual(result, {
    canonicalDeployment: false,
    deployedSha: "b".repeat(40),
    deploymentReceipt: false,
    deploymentStarted: true,
    shouldCheck: false,
    shouldReject: true,
  });
});

test("keeps backend workflow failures classified as deployment events", () => {
  assert.equal(
    classifyDeploymentStarted(".github/workflows/deploy-backend.yml", {
      jobs: [{ name: "deploy", started_at: null, conclusion: "failure" }],
    }),
    true
  );
});

test("rejects unsupported workflow paths instead of treating them as backend", () => {
  assert.throws(() => classifyDeploymentEvent({
    workflowName: ".github/workflows/not-a-deploy.yml",
    workflowEvent: "push",
    headBranch: "main",
    headSha: "4".repeat(40),
    conclusion: "success",
    jobs: [],
  }), /Unsupported deployment workflow/);
});

test("binds each successful deployment health event to its triggering SHA", () => {
  const workflowName = ".github/workflows/deploy-frontend.yml";
  const jobs = [{
    name: "Deploy production",
    started_at: "2026-08-11T16:43:00Z",
    conclusion: "success",
    steps: [
      { name: "Deploy to Azure Static Web Apps", conclusion: "success" },
      { name: "Record canonical deployment receipt", conclusion: "success" },
    ],
  }];
  const aaSha = `aa029f4${"0".repeat(33)}`;
  const laterSha = `7e2862c${"1".repeat(33)}`;

  const first = classifyDeploymentEvent({
    workflowName,
    workflowEvent: "push",
    headBranch: "main",
    headSha: aaSha,
    conclusion: "success",
    jobs,
  });
  const later = classifyDeploymentEvent({
    workflowName,
    workflowEvent: "push",
    headBranch: "main",
    headSha: laterSha,
    conclusion: "success",
    jobs,
  });

  assert.deepEqual(first, {
    canonicalDeployment: true,
    deployedSha: aaSha,
    deploymentReceipt: true,
    deploymentStarted: true,
    shouldCheck: true,
    shouldReject: false,
  });
  assert.equal(later.deployedSha, laterSha);
  assert.equal(later.shouldCheck, true);
  assert.notEqual(first.deployedSha, later.deployedSha);
});

test("fails closed for a non-main or malformed deployment identity", () => {
  const workflowName = ".github/workflows/deploy-frontend.yml";
  const jobs = [{
    name: "Deploy production",
    started_at: "2026-08-11T16:43:00Z",
    conclusion: "success",
    steps: [
      { name: "Deploy to Azure Static Web Apps", conclusion: "success" },
      { name: "Record canonical deployment receipt", conclusion: "success" },
    ],
  }];

  for (const input of [
    { workflowEvent: "workflow_dispatch", headBranch: "feature", headSha: "a".repeat(40) },
    { workflowEvent: "push", headBranch: "main", headSha: "not-a-sha" },
  ]) {
    const result = classifyDeploymentEvent({
      workflowName,
      conclusion: "success",
      jobs,
      ...input,
    });
    assert.equal(result.shouldCheck, false);
    assert.equal(result.shouldReject, true);
  }
});

test("rejects a string dispatch input that can bypass the production choice", () => {
  const result = checkWorkflowRuntimeContracts([
    {
      path: ".github/workflows/deploy-frontend.yml",
      text: `
on:
  workflow_dispatch:
    inputs:
      mode:
        required: true
        default: validate
        type: string
        options:
          - validate
          - production
jobs:
  deploy:
    steps:
      - uses: Azure/static-web-apps-deploy@v1
        with:
          azure_static_web_apps_api_token: \${{ steps.swa_token.outputs.deployment_token }}
          action: upload
`,
    },
  ]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("non-main workflow_dispatch runs validation-only")
    )
  );
});

test("reads active push paths and ignores comments and run script text", () => {
  const inspected = inspectWorkflow(`
on:
  push:
    branches: [main]
    paths:
      - "packages/algorithm/src/**"
      - "packages/server/**"
      # - "packages/algorithm/**"
jobs:
  deploy:
    steps:
      - run: |
          echo "paths:"
          echo "- packages/algorithm/**"
`, ".github/workflows/deploy-backend.yml");

  assert.deepEqual(inspected.pushPaths, [
    "packages/algorithm/src/**",
    "packages/server/**",
  ]);
});

test("rejects broad algorithm paths that deploy documentation changes", () => {
  const result = checkWorkflowRuntimeContracts([
    {
      path: ".github/workflows/deploy-backend.yml",
      text: `
on:
  push:
    paths:
      - "packages/algorithm/**"
      - "packages/server/**"
jobs:
  deploy:
    steps: []
`,
    },
  ]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("runtime algorithm paths")
    )
  );
});

test("requires frontend deployment for every main advancement", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  ).replace(
    "  pull_request:",
    '    paths:\n      - "packages/client/**"\n  pull_request:'
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: frontend }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("every main advancement")
    )
  );
});

test("requires full history and rejects a frontend deploy without retention gates", () => {
  const inspected = inspectWorkflow(`
jobs:
  deploy:
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - run: node scripts/deployment-assets.mjs
`, ".github/workflows/deploy-frontend.yml");
  assert.deepEqual(inspected.checkoutFetchDepths, [{
    path: ".github/workflows/deploy-frontend.yml",
    depth: "0",
  }]);
  assert.ok(inspected.runCommands.includes("node scripts/deployment-assets.mjs"));

  const result = checkWorkflowRuntimeContracts([{
    path: ".github/workflows/deploy-frontend.yml",
    text: `
jobs:
  deploy:
    steps:
      - uses: actions/checkout@v5
`,
  }]);
  assert.ok(result.issues.some((issue) => issue.includes("bounded deployment assets")));
  assert.ok(result.issues.some((issue) => issue.includes("browser contracts")));
});

test("rejects retention gates moved after frontend artifact staging", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  );
  const retentionStart = frontend.indexOf("      - name: Retain bounded deployment assets");
  const markerStart = frontend.indexOf("      - name: Record deployment identity");
  const deployJobStart = frontend.indexOf("  deploy_production:");
  assert.ok(retentionStart >= 0 && markerStart > retentionStart && deployJobStart > markerStart);

  const retentionGates = frontend.slice(retentionStart, markerStart);
  const reordered = [
    frontend.slice(0, retentionStart),
    frontend.slice(markerStart, deployJobStart),
    retentionGates,
    frontend.slice(deployJobStart),
  ].join("");
  const result = checkWorkflowRuntimeContracts([{ path, text: reordered }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("bounded deployment assets unconditionally in build before upload")
    )
  );
  assert.ok(
    result.issues.some((issue) =>
      issue.includes("browser contracts unconditionally in build before upload")
    )
  );
});

test("rejects skipped retention gates", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  )
    .replace(
      "      - name: Retain bounded deployment assets",
      "      - name: Retain bounded deployment assets\n        if: false"
    )
    .replace(
      "      - name: Verify stale deployment browser contracts",
      "      - name: Verify stale deployment browser contracts\n        if: false"
    );
  const result = checkWorkflowRuntimeContracts([{ path, text: frontend }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("bounded deployment assets unconditionally")
    )
  );
  assert.ok(
    result.issues.some((issue) =>
      issue.includes("browser contracts unconditionally")
    )
  );
});

test("rejects failure-tolerant retention gates", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  )
    .replace(
      "      - name: Retain bounded deployment assets",
      "      - name: Retain bounded deployment assets\n        continue-on-error: true"
    )
    .replace(
      "      - name: Verify stale deployment browser contracts",
      "      - name: Verify stale deployment browser contracts\n        continue-on-error: true"
    );
  const result = checkWorkflowRuntimeContracts([{ path, text: frontend }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("bounded deployment assets unconditionally")
    )
  );
  assert.ok(
    result.issues.some((issue) =>
      issue.includes("browser contracts unconditionally")
    )
  );
});

test("requires frontend validation to execute photo loading behavior", () => {
  const path = ".github/workflows/deploy-frontend.yml";
  const frontend = readFileSync(
    new URL("../.github/workflows/deploy-frontend.yml", import.meta.url),
    "utf8"
  ).replace(
    "        run: node scripts/test-photo-loading-behavior.mjs",
    "        run: echo photo-loading-behavior-skipped"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: frontend }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes(
        "must execute frontend gate command node scripts/test-photo-loading-behavior.mjs"
      )
    )
  );
});

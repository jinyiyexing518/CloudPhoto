import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyDeploymentEvent,
  classifyDeploymentStarted,
} from "./classify-deployment-event.mjs";
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
    "production-health-${{ github.event_name == 'workflow_run' && github.event.workflow_run.conclusion != 'success' && format('failure-{0}', github.event.workflow_run.id) || github.event_name == 'workflow_run' && github.event.workflow_run.name == 'Deploy Frontend (Azure Static Web Apps)' && ((github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main') || (github.event.workflow_run.event == 'workflow_dispatch' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.display_title == 'Deploy frontend production · main')) && 'frontend-deployment' || github.event_name == 'workflow_run' && github.event.workflow_run.name == 'Deploy Frontend (Azure Static Web Apps)' && format('frontend-nondeployment-{0}', github.event.workflow_run.id) || github.event_name == 'workflow_run' && github.event.workflow_run.name == 'Deploy Backend (Azure Functions)' && 'backend-deployment' || 'latest' }}",
    "production-health-${{ github.event_name == 'workflow_run' && github.event.workflow_run.conclusion != 'success' && format('failure-{0}', github.event.workflow_run.id) || 'latest' }}"
  );
  const result = checkWorkflowRuntimeContracts([{ path, text: health }]);

  assert.ok(
    result.issues.some((issue) =>
      issue.includes("without hiding deployment failures")
    )
  );
});

test("rejects frontend validation runs that can cancel deployment SHA verification", () => {
  const path = ".github/workflows/production-health.yml";
  const health = readFileSync(
    new URL("../.github/workflows/production-health.yml", import.meta.url),
    "utf8"
  ).replace(
    "production-health-${{ github.event_name == 'workflow_run' && github.event.workflow_run.conclusion != 'success' && format('failure-{0}', github.event.workflow_run.id) || github.event_name == 'workflow_run' && github.event.workflow_run.name == 'Deploy Frontend (Azure Static Web Apps)' && ((github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main') || (github.event.workflow_run.event == 'workflow_dispatch' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.display_title == 'Deploy frontend production · main')) && 'frontend-deployment' || github.event_name == 'workflow_run' && github.event.workflow_run.name == 'Deploy Frontend (Azure Static Web Apps)' && format('frontend-nondeployment-{0}', github.event.workflow_run.id) || github.event_name == 'workflow_run' && github.event.workflow_run.name == 'Deploy Backend (Azure Functions)' && 'backend-deployment' || 'latest' }}",
    "production-health-${{ github.event_name == 'workflow_run' && github.event.workflow_run.conclusion != 'success' && format('failure-{0}', github.event.workflow_run.id) || github.event_name == 'workflow_run' && github.event.workflow_run.name == 'Deploy Frontend (Azure Static Web Apps)' && 'frontend-deployment' || github.event_name == 'workflow_run' && github.event.workflow_run.name == 'Deploy Backend (Azure Functions)' && 'backend-deployment' || 'latest' }}"
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
      ref: "v1",
      token: "${{ steps.swa_token.outputs.deployment_token }}",
    },
  ]);
  assert.equal(inspected.usesRepositorySwaToken, false);
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
`, ".github/workflows/deploy-frontend.yml");

  assert.equal(inspected.staticWebAppActions.length, 1);
  assert.equal(inspected.staticWebAppActions[0].ref, "0123456789abcdef");
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

test("classifies only a started non-skipped frontend production job as deployment", () => {
  const workflow = "Deploy Frontend (Azure Static Web Apps)";

  assert.equal(
    classifyDeploymentStarted(workflow, {
      jobs: [
        {
          name: "Deploy production",
          started_at: "2026-08-11T00:00:00Z",
          conclusion: "failure",
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

test("keeps backend workflow failures classified as deployment events", () => {
  assert.equal(
    classifyDeploymentStarted("Deploy Backend (Azure Functions)", {
      jobs: [{ name: "deploy", started_at: null, conclusion: "failure" }],
    }),
    true
  );
});

test("binds each successful deployment health event to its triggering SHA", () => {
  const workflowName = "Deploy Frontend (Azure Static Web Apps)";
  const jobs = [{
    name: "Deploy production",
    started_at: "2026-08-11T16:43:00Z",
    conclusion: "success",
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
    deploymentStarted: true,
    shouldCheck: true,
    shouldReject: false,
  });
  assert.equal(later.deployedSha, laterSha);
  assert.equal(later.shouldCheck, true);
  assert.notEqual(first.deployedSha, later.deployedSha);
});

test("fails closed for a non-main or malformed deployment identity", () => {
  const workflowName = "Deploy Frontend (Azure Static Web Apps)";
  const jobs = [{
    name: "Deploy production",
    started_at: "2026-08-11T16:43:00Z",
    conclusion: "success",
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

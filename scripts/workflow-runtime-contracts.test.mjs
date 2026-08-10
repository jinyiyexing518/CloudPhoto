import assert from "node:assert/strict";
import test from "node:test";
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

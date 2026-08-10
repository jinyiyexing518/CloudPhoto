#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = dirname(dirname(scriptPath));
const workflowDir = join(root, ".github", "workflows");
const requiredContractWorkflows = [
  ".github/workflows/deploy-backend.yml",
  ".github/workflows/deploy-frontend.yml",
  ".github/workflows/production-health.yml",
  ".github/workflows/sync-changelog.yml",
];
const productionHealthWorkingDirectory = ".deployment";
const productionHealthWorkflow = ".github/workflows/production-health.yml";
const productionHealthConcurrencyGroup =
  "production-health-${{ github.event_name == 'workflow_run' && github.event.workflow_run.conclusion != 'success' && format('failure-{0}', github.event.workflow_run.id) || github.event_name == 'workflow_run' && github.event.workflow_run.name == 'Deploy Frontend (Azure Static Web Apps)' && ((github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main') || (github.event.workflow_run.event == 'workflow_dispatch' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.display_title == 'Deploy frontend production · main')) && 'frontend-deployment' || github.event_name == 'workflow_run' && github.event.workflow_run.name == 'Deploy Frontend (Azure Static Web Apps)' && format('frontend-nondeployment-{0}', github.event.workflow_run.id) || github.event_name == 'workflow_run' && github.event.workflow_run.name == 'Deploy Backend (Azure Functions)' && 'backend-deployment' || 'latest' }}";
const frontendWorkflow = ".github/workflows/deploy-frontend.yml";
const frontendProductionConcurrencyGroup =
  "deploy-frontend-${{ ((github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.mode == 'production')) && 'production' || github.event_name == 'pull_request' && format('validation-pr-{0}', github.event.pull_request.number) || format('validation-{0}', github.ref_name) }}";
const frontendCancelInProgress =
  "${{ !((github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.mode == 'production')) }}";
const frontendUploadCondition =
  "(github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.mode == 'production')";
const frontendUploadToken = "${{ steps.swa_token.outputs.deployment_token }}";
const frontendDeploymentMarkerCommand =
  `printf '{"sha":"%s"}\\n' "$GITHUB_SHA" > packages/client/dist/deployment.json`;
const frontendDispatchModes = ["validate", "production"];
const frontendRunName =
  "${{ github.event_name == 'workflow_dispatch' && github.ref != 'refs/heads/main' && format('Validate frontend · {0}', github.ref_name) || github.event_name == 'workflow_dispatch' && inputs.mode == 'validate' && 'Validate frontend · main' || github.event_name == 'workflow_dispatch' && 'Deploy frontend production · main' || github.event_name == 'pull_request' && format('Validate frontend · PR #{0}', github.event.pull_request.number) || github.workflow }}";
const productionHealthRejectCondition =
  "github.event_name == 'workflow_run' && steps.deployment_event.outputs.should_reject == 'true'";
const productionHealthCheckCondition =
  "github.event_name != 'workflow_run' || steps.deployment_event.outputs.should_check == 'true'";
const productionHealthControllerRef = "${{ github.sha }}";
const productionHealthDeployedRef = "${{ github.event.workflow_run.head_sha }}";
const productionHealthControllerCondition = "github.event_name == 'workflow_run'";
const productionHealthCurrentCondition = "github.event_name != 'workflow_run'";
const productionHealthDeployedCondition =
  "github.event_name == 'workflow_run' && steps.deployment_event.outputs.should_check == 'true'";
const productionHealthClassifierCommand =
  'gh api "repos/$GITHUB_REPOSITORY/actions/runs/$DEPLOYMENT_RUN_ID/jobs?per_page=100" | node .health-control/scripts/classify-deployment-event.mjs --workflow "$DEPLOYMENT_WORKFLOW" --event "$DEPLOYMENT_EVENT" --head-branch "$DEPLOYMENT_HEAD_BRANCH" --head-sha "$DEPLOYMENT_SHA" --conclusion "$DEPLOYMENT_CONCLUSION" >> "$GITHUB_OUTPUT"';
const productionHealthClassifierEnv = {
  DEPLOYMENT_CONCLUSION: "${{ github.event.workflow_run.conclusion }}",
  DEPLOYMENT_EVENT: "${{ github.event.workflow_run.event }}",
  DEPLOYMENT_HEAD_BRANCH: "${{ github.event.workflow_run.head_branch }}",
  DEPLOYMENT_SHA: "${{ github.event.workflow_run.head_sha }}",
};
const productionHealthExpectedSha =
  "${{ github.event_name == 'workflow_run' && github.event.workflow_run.name == 'Deploy Frontend (Azure Static Web Apps)' && steps.deployment_event.outputs.deployed_sha || '' }}";
const productionHealthIdentityCondition =
  "github.event_name == 'workflow_run' && github.event.workflow_run.name == 'Deploy Frontend (Azure Static Web Apps)' && steps.deployment_event.outputs.should_check == 'true'";
const productionHealthClassificationValidationCommand = [
  'for value in "$CANONICAL_DEPLOYMENT" "$DEPLOYMENT_STARTED" "$SHOULD_CHECK" "$SHOULD_REJECT"; do',
  '  case "$value" in',
  "    true|false) ;;",
  '    *) echo "::error::Deployment classifier did not emit a complete boolean contract."; exit 1 ;;',
  "  esac",
  "done",
  'if [[ "$SHOULD_CHECK" == "true" && ! "$DEPLOYED_SHA" =~ ^[0-9a-f]{40}$ ]]; then',
  '  echo "::error::Deployment classifier did not emit a valid deployed SHA."',
  "  exit 1",
  "fi",
  'if [[ "$SHOULD_CHECK" == "true" && "$SHOULD_REJECT" == "true" ]]; then',
  '  echo "::error::Deployment classifier emitted contradictory actions."',
  "  exit 1",
  "fi",
  'if [[ "$DEPLOYMENT_STARTED" == "true" && "$SHOULD_CHECK" != "true" && "$SHOULD_REJECT" != "true" ]]; then',
  '  echo "::error::Deployment classifier left a started deployment without a verdict."',
  "  exit 1",
  "fi",
].join("\n");
const productionHealthGuardedSteps = [
  "Test workflow runtime parser",
  "Verify workflow runtimes",
  "Test smoke checks",
  "Verify security header contracts",
  "Check production",
];
const deployWorkflows = [
  ".github/workflows/deploy-backend.yml",
  frontendWorkflow,
];
const runtimeAlgorithmPaths = [
  "packages/algorithm/src/**",
  "packages/algorithm/package.json",
  "packages/algorithm/tsconfig.json",
];
const frontendGatePaths = ["scripts/auth-layout-cdp.mjs"];

function indentation(line) {
  return line.match(/^\s*/)[0].length;
}

function scalarValue(value) {
  const trimmed = value.replace(/\s+#.*$/, "").trim();
  const quoted = trimmed.match(/^(["'])(.*)\1$/);
  return quoted ? quoted[2] : trimmed;
}

function rootChildField(text, parent, field) {
  const lines = text.split(/\r?\n/);
  const escapedParent = parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parentPattern = new RegExp(`^${escapedParent}:\\s*(?:#.*)?$`);
  const fieldPattern = new RegExp(`^\\s+${escapedField}:\\s*(.*)$`);
  const parentIndex = lines.findIndex((line) => parentPattern.test(line));
  if (parentIndex < 0) return null;

  for (let index = parentIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (indentation(line) === 0) break;
    const match = line.match(fieldPattern);
    if (match) return scalarValue(match[1]);
  }
  return null;
}

function quotedRootScalar(text, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}:\\s*"([^"]*)"\\s*$`, "m");
  return text.match(pattern)?.[1] ?? null;
}

function nestedListItems(text, keys) {
  const lines = text.split(/\r?\n/);
  let parentIndex = -1;
  let parentIndent = -1;

  for (const [depth, key] of keys.entries()) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (depth === 0) {
      const pattern = new RegExp(`^${escaped}:\\s*(?:#.*)?$`);
      parentIndex = lines.findIndex((line) => pattern.test(line));
      if (parentIndex < 0) return [];
      parentIndent = 0;
      continue;
    }

    const pattern = new RegExp(`^\\s+${escaped}:\\s*(?:#.*)?$`);
    let childIndent;
    let childIndex = -1;
    for (let index = parentIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*(?:#.*)?$/.test(line)) continue;
      const lineIndent = indentation(line);
      if (lineIndent <= parentIndent) break;
      if (childIndent === undefined) childIndent = lineIndent;
      if (lineIndent === childIndent && pattern.test(line)) {
        childIndex = index;
        break;
      }
    }
    if (childIndex < 0) return [];
    parentIndex = childIndex;
    parentIndent = childIndent;
  }

  const items = [];
  let itemIndent;
  for (let index = parentIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const lineIndent = indentation(line);
    if (lineIndent <= parentIndent) break;
    if (itemIndent === undefined) itemIndent = lineIndent;
    if (lineIndent !== itemIndent) continue;
    const match = line.match(/^\s*-\s+(.+)$/);
    if (match) items.push(scalarValue(match[1]));
  }
  return items;
}

function nestedScalarValue(text, keys) {
  const lines = text.split(/\r?\n/);
  let parentIndex = -1;
  let parentIndent = -1;

  for (const [depth, key] of keys.entries()) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = depth === 0
      ? new RegExp(`^${escaped}:\\s*(.*)$`)
      : new RegExp(`^\\s+${escaped}:\\s*(.*)$`);
    let childIndent;
    let matchIndex = -1;
    let matchValue = null;

    for (let index = parentIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*(?:#.*)?$/.test(line)) continue;
      const lineIndent = indentation(line);
      if (depth > 0 && lineIndent <= parentIndent) break;
      if (depth > 0 && childIndent === undefined) childIndent = lineIndent;
      if (depth > 0 && lineIndent !== childIndent) continue;
      const match = line.match(pattern);
      if (!match) continue;
      matchIndex = index;
      matchValue = scalarValue(match[1]);
      childIndent = lineIndent;
      break;
    }

    if (matchIndex < 0) return null;
    if (depth === keys.length - 1) return matchValue;
    parentIndex = matchIndex;
    parentIndent = childIndent ?? 0;
  }

  return null;
}

function activeStepBlocks(text) {
  const lines = text.split(/\r?\n/);
  const steps = [];

  for (let index = 0; index < lines.length; index += 1) {
    const stepsLine = lines[index].match(/^(\s*)steps:\s*(?:#.*)?$/);
    if (!stepsLine) continue;

    const stepsIndent = stepsLine[1].length;
    let stepIndent;
    let current;
    let cursor = index + 1;

    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (/^\s*(?:#.*)?$/.test(line)) {
        if (current) current.lines.push(line);
        continue;
      }

      const lineIndent = indentation(line);
      if (lineIndent <= stepsIndent) break;

      if (/^\s*-\s+[A-Za-z_][\w-]*:/.test(line)) {
        if (stepIndent === undefined) stepIndent = lineIndent;
        if (lineIndent === stepIndent) {
          if (current) steps.push(current);
          current = { indent: stepIndent, lines: [line] };
          continue;
        }
      }

      if (current) current.lines.push(line);
    }

    if (current) steps.push(current);
    index = cursor - 1;
  }

  return steps;
}

function stepField(step, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const firstLine = new RegExp(`^\\s{${step.indent}}-\\s+${escaped}:\\s*(.*)$`);
  const otherLine = new RegExp(`^\\s{${step.indent + 2}}${escaped}:\\s*(.*)$`);
  for (const [index, line] of step.lines.entries()) {
    if (/^\s*#/.test(line)) continue;
    const match = line.match(index === 0 ? firstLine : otherLine);
    if (match) return scalarValue(match[1]);
  }
  return null;
}

function stepChildField(step, parent, field) {
  const parentPattern = new RegExp(`^\\s{${step.indent + 2}}${parent}:\\s*(?:#.*)?$`);
  const childPattern = new RegExp(`^\\s{${step.indent + 4}}${field}:\\s*(.*)$`);
  const parentIndex = step.lines.findIndex((line) => parentPattern.test(line));
  if (parentIndex < 0) return null;

  for (let index = parentIndex + 1; index < step.lines.length; index += 1) {
    const line = step.lines[index];
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (indentation(line) <= step.indent + 2) break;
    const match = line.match(childPattern);
    if (match) return scalarValue(match[1]);
  }
  return null;
}

function stepBlockScalar(step, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fieldPattern = new RegExp(`^\\s{${step.indent + 2}}${escaped}:\\s*\\|\\s*$`);
  const fieldIndex = step.lines.findIndex((line) => fieldPattern.test(line));
  if (fieldIndex < 0) return null;

  return step.lines
    .slice(fieldIndex + 1)
    .filter((line) => indentation(line) > step.indent + 2)
    .map((line) => line.slice(step.indent + 4))
    .join("\n")
    .trim();
}

export function inspectWorkflow(text, path = "workflow.yml") {
  const azureLoginRefs = [];
  const setupNodeVersions = [];
  const contractInvocations = [];
  const pushPaths = nestedListItems(text, ["on", "push", "paths"]);
  const workflowDispatchModes = nestedListItems(text, [
    "on",
    "workflow_dispatch",
    "inputs",
    "mode",
    "options",
  ]);
  const workflowDispatchModeDefault = nestedScalarValue(text, [
    "on",
    "workflow_dispatch",
    "inputs",
    "mode",
    "default",
  ]);
  const workflowDispatchModeRequired = nestedScalarValue(text, [
    "on",
    "workflow_dispatch",
    "inputs",
    "mode",
    "required",
  ]);
  const workflowDispatchModeType = nestedScalarValue(text, [
    "on",
    "workflow_dispatch",
    "inputs",
    "mode",
    "type",
  ]);
  const staticWebAppActions = [];
  const checkoutRefs = [];
  const activeSource = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const usesRepositorySwaToken =
    /secrets\s*(?:\.\s*AZURE_STATIC_WEB_APPS_API_TOKEN|\[\s*["']AZURE_STATIC_WEB_APPS_API_TOKEN["']\s*\])/i
      .test(activeSource);
  const stepConditions = {};
  const stepWorkingDirectories = {};
  let frontendTokenResolver = null;
  let frontendDeploymentMarker = null;
  let productionHealthClassification = null;
  let productionHealthClassificationValidation = null;
  let productionHealthCheck = null;
  let productionHealthIdentityCheck = null;
  const concurrency = {
    group: rootChildField(text, "concurrency", "group"),
    cancelInProgress: rootChildField(text, "concurrency", "cancel-in-progress"),
  };

  for (const step of activeStepBlocks(text)) {
    const name = stepField(step, "name");
    const uses = stepField(step, "uses");
    const azureLogin = uses?.match(/^azure\/login@(.+)$/);
    if (azureLogin) {
      azureLoginRefs.push({ path, version: azureLogin[1] });
    }

    const setupNode = uses?.match(/^actions\/setup-node@(.+)$/);
    if (setupNode) {
      setupNodeVersions.push({
        path,
        actionVersion: setupNode[1],
        version: stepChildField(step, "with", "node-version"),
      });
    }

    if (uses?.startsWith("actions/checkout@")) {
      checkoutRefs.push({
        name,
        condition: stepField(step, "if"),
        path: stepChildField(step, "with", "path"),
        ref: stepChildField(step, "with", "ref"),
      });
    }

    if (stepField(step, "run") === "node scripts/check-workflow-runtime-contracts.mjs") {
      contractInvocations.push(path);
    }

    const staticWebApp = uses?.match(/^azure\/static-web-apps-deploy@(.+)$/i);
    if (staticWebApp) {
      staticWebAppActions.push({
        action: stepChildField(step, "with", "action"),
        path,
        condition: stepField(step, "if"),
        ref: staticWebApp[1],
        token: stepChildField(step, "with", "azure_static_web_apps_api_token"),
      });
    }

    if (name) {
      stepConditions[name] = stepField(step, "if");
      stepWorkingDirectories[name] = stepField(step, "working-directory");
    }
    if (name === "Classify deployment event") {
      productionHealthClassification = {
        condition: stepField(step, "if"),
        ghToken: stepChildField(step, "env", "GH_TOKEN"),
        deploymentConclusion: stepChildField(step, "env", "DEPLOYMENT_CONCLUSION"),
        deploymentEvent: stepChildField(step, "env", "DEPLOYMENT_EVENT"),
        deploymentHeadBranch: stepChildField(step, "env", "DEPLOYMENT_HEAD_BRANCH"),
        deploymentSha: stepChildField(step, "env", "DEPLOYMENT_SHA"),
        command: stepField(step, "run"),
      };
    }
    if (name === "Check production") {
      productionHealthCheck = {
        expectedSha: stepChildField(step, "env", "PRODUCTION_DEPLOYED_SHA"),
      };
    }
    if (name === "Verify deployed artifact identity") {
      productionHealthIdentityCheck = {
        command: stepField(step, "run"),
        expectedSha: stepChildField(step, "env", "PRODUCTION_DEPLOYED_SHA"),
        scope: stepChildField(step, "env", "PRODUCTION_SMOKE_SCOPE"),
      };
    }
    if (name === "Validate deployment classification") {
      productionHealthClassificationValidation = {
        condition: stepField(step, "if"),
        canonicalDeployment: stepChildField(step, "env", "CANONICAL_DEPLOYMENT"),
        deployedSha: stepChildField(step, "env", "DEPLOYED_SHA"),
        deploymentStarted: stepChildField(step, "env", "DEPLOYMENT_STARTED"),
        shouldCheck: stepChildField(step, "env", "SHOULD_CHECK"),
        shouldReject: stepChildField(step, "env", "SHOULD_REJECT"),
        command: stepBlockScalar(step, "run"),
      };
    }
    if (name === "Record deployment identity") {
      frontendDeploymentMarker = {
        condition: stepField(step, "if"),
        command: stepField(step, "run"),
      };
    }
    if (stepField(step, "id") === "swa_token") {
      frontendTokenResolver = {
        source: step.lines.join("\n"),
      };
    }
  }

  return {
    azureLoginRefs,
    checkoutRefs,
    setupNodeVersions,
    contractInvocations,
    concurrency,
    pushPaths,
    runName: quotedRootScalar(text, "run-name"),
    staticWebAppActions,
    stepConditions,
    stepWorkingDirectories,
    frontendTokenResolver,
    frontendDeploymentMarker,
    productionHealthClassification,
    productionHealthClassificationValidation,
    productionHealthCheck,
    productionHealthIdentityCheck,
    usesRepositorySwaToken,
    workflowDispatchModeDefault,
    workflowDispatchModes,
    workflowDispatchModeRequired,
    workflowDispatchModeType,
  };
}

export function checkWorkflowRuntimeContracts(workflows) {
  const issues = [];
  const healthWorkflow = workflows.find(
    (workflow) => workflow.path === productionHealthWorkflow
  );
  const healthConcurrency = healthWorkflow
    ? inspectWorkflow(healthWorkflow.text, healthWorkflow.path).concurrency
    : null;
  const healthPolicy = healthWorkflow
    ? inspectWorkflow(healthWorkflow.text, healthWorkflow.path)
    : null;
  const frontend = workflows.find((workflow) => workflow.path === frontendWorkflow);
  const frontendPolicy = frontend
    ? inspectWorkflow(frontend.text, frontend.path)
    : null;
  const deployPushPaths = Object.fromEntries(
    deployWorkflows.map((path) => {
      const workflow = workflows.find((candidate) => candidate.path === path);
      return [path, workflow ? inspectWorkflow(workflow.text, path).pushPaths : null];
    })
  );
  const aggregate = workflows.reduce(
    (result, workflow) => {
      const inspected = inspectWorkflow(workflow.text, workflow.path);
      result.azureLoginRefs.push(...inspected.azureLoginRefs);
      result.setupNodeVersions.push(...inspected.setupNodeVersions);
      result.contractInvocations.push(...inspected.contractInvocations);
      return result;
    },
    { azureLoginRefs: [], setupNodeVersions: [], contractInvocations: [] }
  );

  for (const reference of aggregate.azureLoginRefs) {
    if (reference.version !== "v3") {
      issues.push(`${reference.path} must use azure/login@v3, found @${reference.version}`);
    }
  }
  for (const setup of aggregate.setupNodeVersions) {
    if (setup.actionVersion !== "v7") {
      issues.push(
        `${setup.path} must use actions/setup-node@v7, found @${setup.actionVersion}`
      );
    }
    if (setup.version !== "24") {
      issues.push(
        `${setup.path} setup-node must select Node 24, found ${setup.version ?? "no version"}`
      );
    }
  }
  if (aggregate.azureLoginRefs.length !== 6) {
    issues.push(`expected six Azure login steps, found ${aggregate.azureLoginRefs.length}`);
  }
  if (aggregate.setupNodeVersions.length !== 4) {
    issues.push(`expected four setup-node steps, found ${aggregate.setupNodeVersions.length}`);
  }
  for (const workflow of requiredContractWorkflows) {
    if (!aggregate.contractInvocations.includes(workflow)) {
      issues.push(`${workflow} must run the workflow runtime contract`);
    }
  }
  if (aggregate.contractInvocations.length !== requiredContractWorkflows.length) {
    issues.push(
      `expected ${requiredContractWorkflows.length} workflow contract steps, found ${aggregate.contractInvocations.length}`
    );
  }
  if (!healthConcurrency) {
    issues.push(`${productionHealthWorkflow} is missing`);
  } else {
    if (healthConcurrency.group !== productionHealthConcurrencyGroup) {
      issues.push(
        `${productionHealthWorkflow} concurrency group must coalesce fresh checks without hiding deployment failures, found ${
          healthConcurrency.group ?? "no group"
        }`
      );
    }
    if (healthConcurrency.cancelInProgress !== "true") {
      issues.push(
        `${productionHealthWorkflow} must cancel stale in-progress checks, found cancel-in-progress: ${
          healthConcurrency.cancelInProgress ?? "missing"
        }`
      );
    }
  }
  if (
    !healthPolicy?.productionHealthClassification
    || healthPolicy.productionHealthClassification.condition !== "github.event_name == 'workflow_run'"
    || healthPolicy.productionHealthClassification.ghToken !== "${{ secrets.GITHUB_TOKEN }}"
    || healthPolicy.productionHealthClassification.deploymentConclusion
      !== productionHealthClassifierEnv.DEPLOYMENT_CONCLUSION
    || healthPolicy.productionHealthClassification.deploymentEvent
      !== productionHealthClassifierEnv.DEPLOYMENT_EVENT
    || healthPolicy.productionHealthClassification.deploymentHeadBranch
      !== productionHealthClassifierEnv.DEPLOYMENT_HEAD_BRANCH
    || healthPolicy.productionHealthClassification.deploymentSha
      !== productionHealthClassifierEnv.DEPLOYMENT_SHA
    || healthPolicy.productionHealthClassification.command !== productionHealthClassifierCommand
    || healthPolicy.stepConditions["Reject failed deployment"] !== productionHealthRejectCondition
    || productionHealthGuardedSteps.some(
      (name) => healthPolicy.stepConditions[name] !== productionHealthCheckCondition
    )
  ) {
    issues.push(
      `${productionHealthWorkflow} must ignore validation/coalesced frontend runs that never started production deployment`
    );
  }
  if (
    healthPolicy?.stepConditions["Verify deployed artifact identity"]
      !== productionHealthIdentityCondition
    || healthPolicy.stepWorkingDirectories["Verify deployed artifact identity"]
      !== ".health-control"
    || healthPolicy.productionHealthIdentityCheck?.expectedSha
      !== "${{ steps.deployment_event.outputs.deployed_sha }}"
    || healthPolicy.productionHealthIdentityCheck?.scope !== "deployment"
    || healthPolicy.productionHealthIdentityCheck?.command
      !== "node scripts/production-smoke.mjs"
  ) {
    issues.push(
      `${productionHealthWorkflow} must keep a controller-owned deployment marker gate for historical deployed revisions`
    );
  }
  if (
    healthPolicy?.productionHealthClassificationValidation?.condition
      !== "github.event_name == 'workflow_run'"
    || healthPolicy.productionHealthClassificationValidation.canonicalDeployment
      !== "${{ steps.deployment_event.outputs.canonical_deployment }}"
    || healthPolicy.productionHealthClassificationValidation.deployedSha
      !== "${{ steps.deployment_event.outputs.deployed_sha }}"
    || healthPolicy.productionHealthClassificationValidation.deploymentStarted
      !== "${{ steps.deployment_event.outputs.deployment_started }}"
    || healthPolicy.productionHealthClassificationValidation.shouldCheck
      !== "${{ steps.deployment_event.outputs.should_check }}"
    || healthPolicy.productionHealthClassificationValidation.shouldReject
      !== "${{ steps.deployment_event.outputs.should_reject }}"
    || healthPolicy.productionHealthClassificationValidation.command
      !== productionHealthClassificationValidationCommand
  ) {
    issues.push(
      `${productionHealthWorkflow} must fail closed when classifier outputs are missing or contradictory`
    );
  }
  const healthCheckouts = Object.fromEntries(
    (healthPolicy?.checkoutRefs ?? []).map((checkout) => [checkout.name, checkout])
  );
  if (
    healthPolicy?.checkoutRefs.length !== 3
    || healthCheckouts["Checkout health controller"]?.condition
      !== productionHealthControllerCondition
    || healthCheckouts["Checkout health controller"]?.ref !== productionHealthControllerRef
    || healthCheckouts["Checkout health controller"]?.path !== ".health-control"
    || healthCheckouts["Checkout current revision"]?.condition
      !== productionHealthCurrentCondition
    || healthCheckouts["Checkout current revision"]?.ref !== null
    || healthCheckouts["Checkout current revision"]?.path !== productionHealthWorkingDirectory
    || healthCheckouts["Checkout deployed revision"]?.condition
      !== productionHealthDeployedCondition
    || healthCheckouts["Checkout deployed revision"]?.ref !== productionHealthDeployedRef
    || healthCheckouts["Checkout deployed revision"]?.path !== productionHealthWorkingDirectory
    || productionHealthGuardedSteps.some(
      (name) => healthPolicy.stepWorkingDirectories[name] !== productionHealthWorkingDirectory
    )
    || healthPolicy.productionHealthCheck?.expectedSha !== productionHealthExpectedSha
  ) {
    issues.push(
      `${productionHealthWorkflow} must checkout and verify the triggering deployed SHA instead of the current main SHA`
    );
  }
  if (!frontendPolicy) {
    issues.push(`${frontendWorkflow} is missing`);
  } else {
    if (
      frontendPolicy.concurrency.group !== frontendProductionConcurrencyGroup
      || frontendPolicy.concurrency.cancelInProgress !== frontendCancelInProgress
    ) {
      issues.push(
        `${frontendWorkflow} must serialize the production target without canceling an in-flight production upload`
      );
    }
    if (
      frontendPolicy.runName !== frontendRunName
      || frontendPolicy.workflowDispatchModeDefault !== "validate"
      || frontendPolicy.workflowDispatchModeRequired !== "true"
      || frontendPolicy.workflowDispatchModeType !== "choice"
      || frontendPolicy.workflowDispatchModes.length !== frontendDispatchModes.length
      || frontendDispatchModes.some(
        (mode, index) => frontendPolicy.workflowDispatchModes[index] !== mode
      )
      || frontendPolicy.staticWebAppActions.length !== 1
      || frontendPolicy.staticWebAppActions[0]?.action !== "upload"
      || frontendPolicy.staticWebAppActions[0]?.condition !== frontendUploadCondition
      || frontendPolicy.staticWebAppActions[0]?.ref !== "v1"
      || frontendPolicy.staticWebAppActions[0]?.token !== frontendUploadToken
      || frontendPolicy.usesRepositorySwaToken
      || !frontendPolicy.frontendTokenResolver
      || frontendPolicy.frontendDeploymentMarker?.condition !== frontendUploadCondition
      || frontendPolicy.frontendDeploymentMarker?.command !== frontendDeploymentMarkerCommand
      || !frontendPolicy.frontendTokenResolver.source.includes(
        "az staticwebapp secrets list"
      )
      || !frontendPolicy.frontendTokenResolver.source.includes(
        'echo "::add-mask::$DEPLOYMENT_TOKEN"'
      )
      || !frontendPolicy.frontendTokenResolver.source.includes(
        'echo "deployment_token=$DEPLOYMENT_TOKEN" >> "$GITHUB_OUTPUT"'
      )
    ) {
      issues.push(
        `${frontendWorkflow} must keep non-main workflow_dispatch runs validation-only and guard the production upload`
      );
    }
  }
  for (const [path, pushPaths] of Object.entries(deployPushPaths)) {
    if (!pushPaths) {
      issues.push(`${path} is missing`);
      continue;
    }
    for (const requiredPath of runtimeAlgorithmPaths) {
      if (!pushPaths.includes(requiredPath)) {
        issues.push(`${path} must include runtime algorithm path ${requiredPath}`);
      }
    }
    for (const configuredPath of pushPaths) {
      if (
        configuredPath.startsWith("packages/algorithm/")
        && !runtimeAlgorithmPaths.includes(configuredPath)
      ) {
        issues.push(
          `${path} must use only runtime algorithm paths, found ${configuredPath}`
        );
      }
    }
  }
  for (const requiredPath of frontendGatePaths) {
    if (!deployPushPaths[frontendWorkflow]?.includes(requiredPath)) {
      issues.push(`${frontendWorkflow} must include frontend gate path ${requiredPath}`);
    }
  }

  return {
    ...aggregate,
    frontendPolicy,
    healthConcurrency,
    healthPolicy,
    deployPushPaths,
    issues,
  };
}

function main() {
  const workflows = readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .map((name) => {
      const path = join(workflowDir, name);
      return {
        path: relative(root, path).replaceAll("\\", "/"),
        text: readFileSync(path, "utf8"),
      };
    });
  const result = checkWorkflowRuntimeContracts(workflows);

  if (result.issues.length > 0) {
    throw new Error(`Workflow runtime contract failed:\n- ${result.issues.join("\n- ")}`);
  }

  console.log(
    `Workflow runtime contract passed: azure-login=${result.azureLoginRefs.length}@v3 setup-node=${result.setupNodeVersions.length}@v7/node24 enforced-by=${result.contractInvocations.length} health-cancel-stale=${result.healthConcurrency.cancelInProgress} frontend-production=serialized frontend-dispatch=validation-guarded algorithm-runtime-paths=${runtimeAlgorithmPaths.length}x${deployWorkflows.length}`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main();
}

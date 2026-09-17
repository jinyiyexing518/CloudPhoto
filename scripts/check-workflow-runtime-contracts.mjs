#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  backendDeploymentPaths,
  backendDeploymentTriggerPaths,
} from "./check-backend-deployment-target.mjs";

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
  "production-health-${{ github.event_name == 'workflow_run' && github.event.workflow_run.path == '.github/workflows/deploy-frontend.yml' && format('frontend-event-{0}-{1}', github.event.workflow_run.id, github.event.workflow_run.run_attempt) || github.event_name == 'workflow_run' && github.event.workflow_run.conclusion != 'success' && format('failure-{0}-{1}', github.event.workflow_run.id, github.event.workflow_run.run_attempt) || github.event_name == 'workflow_run' && github.event.workflow_run.path == '.github/workflows/deploy-backend.yml' && 'backend-deployment' || 'latest' }}";
const backendWorkflow = ".github/workflows/deploy-backend.yml";
const backendProductionConcurrencyGroup =
  "deploy-backend-${{ github.ref == 'refs/heads/main' && 'production' || format('validation-{0}', github.ref_name) }}";
const backendCancelInProgress = "${{ github.ref != 'refs/heads/main' }}";
const backendProductionJobCondition = "github.ref == 'refs/heads/main'";
const backendDeploymentPackageCommand = [
  "mkdir -p deploy-stage",
  "cp -r packages/server/dist deploy-stage/",
  "cp packages/server/package.json deploy-stage/",
  "cp packages/server/host.json deploy-stage/",
  "cp yarn.lock deploy-stage/",
  "cp packages/server/.funcignore deploy-stage/ 2>/dev/null || true",
  `printf '{"sha":"%s"}\\n' "$GITHUB_SHA" > deploy-stage/deployment.json`,
  "cd deploy-stage",
  "yarn install --frozen-lockfile --production --offline --non-interactive",
  "cd ..",
  "node scripts/check-backend-package-dependencies.mjs",
  "cd deploy-stage",
  "# Azure Functions runs on Windows — directly download the Windows sharp binary",
  "# from npm registry, bypassing npm's platform check entirely.",
  `SHARP_VER=$(node -e "console.log(require('./node_modules/sharp/package.json').version)")`,
  'SHARP_TARBALL="sharp-win32-x64-${SHARP_VER}.tgz"',
  "curl --fail --silent --show-error --location --retry 3 \\",
  '  --output "$SHARP_TARBALL" \\',
  '  "https://registry.npmjs.org/@img/sharp-win32-x64/-/${SHARP_TARBALL}"',
  "cd ..",
  "node scripts/check-backend-package-dependencies.mjs \\",
  '  --verify-windows-sharp "deploy-stage/${SHARP_TARBALL}" "$SHARP_VER"',
  "cd deploy-stage",
  "mkdir -p node_modules/@img/sharp-win32-x64",
  'tar xzf "$SHARP_TARBALL" --strip-components=1 -C node_modules/@img/sharp-win32-x64',
  'rm "$SHARP_TARBALL"',
  "zip -r ../deployment.zip .",
].join("\n");
const backendReceiptCommand = "node scripts/production-smoke.mjs";
const backendReceiptExpectedSha = "${{ github.sha }}";
const backendReceiptScope = "backend-deployment";
const backendRequeueTargetCommand =
  "node scripts/check-backend-deployment-target.mjs --requeue-current";
const backendReadOnlyTargetCommand =
  "node scripts/check-backend-deployment-target.mjs";
const backendTargetToken = "${{ secrets.GITHUB_TOKEN }}";
const backendPolicyTestCommand =
  "node --test scripts/backend-deployment-target.test.mjs scripts/production-smoke.test.mjs scripts/workflow-runtime-contracts.test.mjs";
const backendRequeueTargetStepNames = [
  "Verify backend deployment target before Azure login",
  "Reverify backend deployment target before Azure upload",
];
const backendDeployTargetStepNames = [
  "Verify deployment target inside deploy before Azure login",
  "Reverify deployment target immediately before Azure upload",
];
const backendTargetStepNames = [
  ...backendRequeueTargetStepNames,
  ...backendDeployTargetStepNames,
];
const backendRequiredStepNames = [
  "Checkout target history",
  "Setup target Node.js",
  "Verify backend deployment target before Azure login",
  "Checkout build revision",
  "Setup build Node.js",
  "Verify workflow runtimes",
  "Test backend deployment policy",
  "Install dependencies",
  "Build TypeScript",
  "Test backend",
  "Create deployment package",
  "Stage backend deployment package",
  "Checkout target history",
  "Setup target Node.js",
  "Reverify backend deployment target before Azure upload",
  "Checkout deployment receipt",
  "Checkout deployment target history",
  "Setup deployment Node.js",
  "Download backend deployment package",
  "Verify deployment package identity",
  "Verify deployment target inside deploy before Azure login",
  "Azure Login (attempt 1)",
  "Azure Login (attempt 2)",
  "Verify Azure Login",
  "Ensure production auth CORS origins",
  "Reverify deployment target immediately before Azure upload",
  "Deploy to Azure Functions",
  "Record canonical backend deployment receipt",
];
const backendConditionalStepPolicy = {
  "Azure Login (attempt 1)": {
    condition: null,
    continueOnError: "true",
  },
  "Azure Login (attempt 2)": {
    condition: "steps.azure_login_first.outcome == 'failure'",
    continueOnError: null,
  },
  "Verify Azure Login": {
    condition:
      "steps.azure_login_first.outcome == 'failure' && steps.azure_login_second.outcome == 'failure'",
    continueOnError: null,
  },
};
const backendArtifactName = "backend-package";
const backendArtifactPath = "deployment.zip";
const backendPackageIdentityStepId = "backend_package_identity";
const backendPackageIdentityCommand = [
  `test "$(unzip -Z1 deployment.zip | grep -c '^deployment.json$')" -eq 1`,
  `test "$(unzip -p deployment.zip deployment.json)" = "{\\"sha\\":\\"$GITHUB_SHA\\"}"`,
  `echo "sha256=$(sha256sum deployment.zip | awk '{print $1}')" >> "$GITHUB_OUTPUT"`,
].join("\n");
const backendDeploymentCommand = [
  `test "$(sha256sum deployment.zip | awk '{print $1}')" = "\${{ steps.backend_package_identity.outputs.sha256 }}"`,
  "az functionapp deployment source config-zip \\",
  "  --resource-group ${{ secrets.AZURE_RESOURCE_GROUP }} \\",
  "  --name ${{ secrets.AZURE_FUNCTIONAPP_NAME }} \\",
  "  --src deployment.zip",
].join("\n");
const backendCorsCommand = [
  "az functionapp cors add \\",
  "  --resource-group ${{ secrets.AZURE_RESOURCE_GROUP }} \\",
  "  --name ${{ secrets.AZURE_FUNCTIONAPP_NAME }} \\",
  "  --allowed-origins \\",
  "    https://cloudphotos.top \\",
  "    https://www.cloudphotos.top \\",
  "    https://brave-sand-053b07a00.7.azurestaticapps.net \\",
  "  --output none",
  'allowed_origins="$(az functionapp cors show \\',
  "  --resource-group ${{ secrets.AZURE_RESOURCE_GROUP }} \\",
  "  --name ${{ secrets.AZURE_FUNCTIONAPP_NAME }} \\",
  "  --query 'allowedOrigins[]' \\",
  '  --output tsv)"',
  "for required_origin in \\",
  "  https://cloudphotos.top \\",
  "  https://www.cloudphotos.top \\",
  "  https://brave-sand-053b07a00.7.azurestaticapps.net",
  "do",
  '  if ! grep -Fqx "$required_origin" <<< "$allowed_origins"; then',
  '    echo "Required production auth CORS origin is missing: $required_origin"',
  "    exit 1",
  "  fi",
  "done",
  'if grep -Fqx "*" <<< "$allowed_origins"; then',
  '  echo "Wildcard production auth CORS is forbidden"',
  "  exit 1",
  "fi",
].join("\n");
const frontendWorkflow = ".github/workflows/deploy-frontend.yml";
const frontendProductionConcurrencyGroup =
  "deploy-frontend-${{ ((github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.mode == 'production')) && 'production' || github.event_name == 'pull_request' && format('validation-pr-{0}', github.event.pull_request.number) || format('validation-{0}', github.ref_name) }}";
const frontendCancelInProgress =
  "${{ !((github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.mode == 'production')) }}";
const frontendUploadCondition =
  "(github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.mode == 'production')";
const frontendActualUploadCondition =
  `(${frontendUploadCondition}) && steps.deployment_ownership_final.outputs.should_deploy == 'true'`;
const frontendOwnershipCommand = "node scripts/check-frontend-deployment-ownership.mjs";
const frontendInitialOwnershipCondition = null;
const frontendFinalOwnershipCondition =
  "steps.deployment_ownership_initial.outputs.should_deploy == 'true'";
const frontendReceiptCommand =
  "node scripts/check-frontend-deployment-ownership.mjs --confirm-current-main";
const frontendRequeueCommand =
  "gh workflow run deploy-frontend.yml --ref main -f mode=production";
const frontendUploadToken = "${{ steps.swa_token.outputs.deployment_token }}";
const frontendArtifactName = "frontend-dist";
const frontendArtifactPath = "packages/client/dist";
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
  'gh api "repos/$GITHUB_REPOSITORY/actions/runs/$DEPLOYMENT_RUN_ID/attempts/$DEPLOYMENT_RUN_ATTEMPT/jobs?per_page=100" | node .health-control/scripts/classify-deployment-event.mjs --workflow "$DEPLOYMENT_WORKFLOW" --event "$DEPLOYMENT_EVENT" --head-branch "$DEPLOYMENT_HEAD_BRANCH" --head-sha "$DEPLOYMENT_SHA" --conclusion "$DEPLOYMENT_CONCLUSION" >> "$GITHUB_OUTPUT"';
const productionHealthClassifierEnv = {
  DEPLOYMENT_CONCLUSION: "${{ github.event.workflow_run.conclusion }}",
  DEPLOYMENT_EVENT: "${{ github.event.workflow_run.event }}",
  DEPLOYMENT_HEAD_BRANCH: "${{ github.event.workflow_run.head_branch }}",
  DEPLOYMENT_RUN_ID: "${{ github.event.workflow_run.id }}",
  DEPLOYMENT_RUN_ATTEMPT: "${{ github.event.workflow_run.run_attempt }}",
  DEPLOYMENT_SHA: "${{ github.event.workflow_run.head_sha }}",
  DEPLOYMENT_WORKFLOW: "${{ github.event.workflow_run.path }}",
};
const productionHealthExpectedSha =
  "${{ github.event_name == 'workflow_run' && github.event.workflow_run.path == '.github/workflows/deploy-frontend.yml' && steps.deployment_event.outputs.deployed_sha || '' }}";
const productionHealthExpectedBackendSha =
  "${{ github.event_name == 'workflow_run' && github.event.workflow_run.path == '.github/workflows/deploy-backend.yml' && steps.deployment_event.outputs.deployed_sha || '' }}";
const productionHealthIdentityCondition =
  "github.event_name == 'workflow_run' && github.event.workflow_run.path == '.github/workflows/deploy-frontend.yml' && steps.deployment_event.outputs.should_check == 'true'";
const productionHealthBackendIdentityCondition =
  "github.event_name == 'workflow_run' && github.event.workflow_run.path == '.github/workflows/deploy-backend.yml' && steps.deployment_event.outputs.should_check == 'true'";
const productionHealthClassificationValidationCommand = [
  'for value in "$CANONICAL_DEPLOYMENT" "$DEPLOYMENT_RECEIPT" "$DEPLOYMENT_STARTED" "$SHOULD_CHECK" "$SHOULD_REJECT"; do',
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
  'if [[ "$DEPLOYMENT_RECEIPT" == "true" && "$DEPLOYMENT_STARTED" != "true" ]]; then',
  '  echo "::error::Deployment classifier emitted a receipt without an Azure upload attempt."',
  "  exit 1",
  "fi",
  'if [[ "$DEPLOYMENT_STARTED" == "true" && "$SHOULD_CHECK" != "true" && "$SHOULD_REJECT" != "true" ]]; then',
  '  echo "::error::Deployment classifier left a started deployment without a verdict."',
  "  exit 1",
  "fi",
].join("\n");
const productionHealthWorkflowTestCommand =
  "node --test scripts/backend-deployment-target.test.mjs scripts/workflow-runtime-contracts.test.mjs";
const productionHealthGuardedSteps = [
  "Test workflow runtime parser",
  "Verify workflow runtimes",
  "Test smoke checks",
  "Verify security header contracts",
  "Check production",
];
const deployWorkflows = [
  backendWorkflow,
  frontendWorkflow,
];
const retentionCommand =
  'node scripts/deployment-assets.mjs --dist packages/client/dist --generation "$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --source https://brave-sand-053b07a00.7.azurestaticapps.net --policy packages/client/deployment-retention.json';
const browserContractCommand =
  "node --test --test-force-exit scripts/deployment-asset-retention.test.mjs scripts/stale-deployment-browser.test.mjs";
const runtimeAlgorithmPaths = [
  "packages/algorithm/src/**",
  "packages/algorithm/package.json",
  "packages/algorithm/tsconfig.json",
];
const frontendGateCommands = [
  "node scripts/test-photo-loading-behavior.mjs",
  "yarn test:memory-map-locations",
];

function indentation(line) {
  return line.match(/^\s*/)[0].length;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function yamlKeyPattern(key) {
  const escaped = escapeRegex(key);
  return `(?:${escaped}|"${escaped}"|'${escaped}')`;
}

const yamlKeyCapture = `(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\\w-]*))`;

function capturedYamlKey(match) {
  return match[1] ?? match[2] ?? match[3];
}

const yamlMappingKeyToken =
  `(?:"(?:\\\\.|[^"\\\\])*"|'(?:''|[^'])*'|[A-Za-z_][\\w-]*|<<)`;

function decodeYamlMappingKey(token) {
  if (token.startsWith('"')) {
    if (token.includes("\\")) return null;
    return token.slice(1, -1);
  }
  if (token.startsWith("'")) {
    if (token.slice(1, -1).includes("''")) return null;
    return token.slice(1, -1);
  }
  return token;
}

function inspectSupportedYamlSubset(text) {
  const lines = text.split(/\r?\n/);
  const issues = [];
  const contexts = [];
  let blockScalarIndent = null;

  for (const [index, line] of lines.entries()) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const lineIndent = indentation(line);
    if (blockScalarIndent !== null) {
      if (lineIndent > blockScalarIndent) continue;
      blockScalarIndent = null;
    }
    const trimmed = line.trim();
    if (
      /^\?(?:\s|$)/.test(trimmed)
      || /^:(?:\s|$)/.test(trimmed)
      || /^-\s*(?:$|[\[{!?&*])/.test(trimmed)
      || /^(?:<<|"<<"|'<<')\s*:/.test(trimmed)
      || /:\s*[&*][A-Za-z_]/.test(trimmed)
      || /:\s*\{/.test(trimmed)
    ) {
      issues.push(index + 1);
      continue;
    }

    const sequenceMatch = line.match(
      new RegExp(`^(\\s*)-\\s+(${yamlMappingKeyToken}):\\s*(.*)$`)
    );
    const mappingMatch = sequenceMatch
      ? null
      : line.match(
        new RegExp(`^(\\s*)(${yamlMappingKeyToken}):\\s*(.*)$`)
      );
    if (!sequenceMatch && !mappingMatch) continue;

    const isSequence = Boolean(sequenceMatch);
    const match = sequenceMatch ?? mappingMatch;
    const keyToken = match[2];
    const key = decodeYamlMappingKey(keyToken);
    const value = match[3].replace(/\s+#.*$/, "").trim();
    if (key === null) {
      issues.push(index + 1);
      continue;
    }

    if (isSequence) {
      while (contexts.at(-1)?.indent > lineIndent) contexts.pop();
      const context = { indent: lineIndent + 2, keys: new Set([key]) };
      contexts.push(context);
    } else {
      while (contexts.at(-1)?.indent > lineIndent) contexts.pop();
      let context = contexts.findLast((candidate) => candidate.indent === lineIndent);
      if (!context) {
        context = { indent: lineIndent, keys: new Set() };
        contexts.push(context);
      }
      if (context.keys.has(key)) {
        issues.push(index + 1);
        continue;
      }
      context.keys.add(key);
    }

    if (/^[|>][+-]?\d?$/.test(value)) {
      blockScalarIndent = isSequence ? lineIndent + 2 : lineIndent;
    } else if (value === "") {
      const childIndent = isSequence ? lineIndent + 4 : lineIndent + 2;
      while (contexts.at(-1)?.indent >= childIndent) contexts.pop();
      contexts.push({ indent: childIndent, keys: new Set() });
    }
  }
  return issues;
}

function scalarValue(value) {
  const trimmed = value.replace(/\s+#.*$/, "").trim();
  const quoted = trimmed.match(/^(["'])(.*)\1$/);
  return quoted ? quoted[2] : trimmed;
}

function rootChildField(text, parent, field) {
  const lines = text.split(/\r?\n/);
  const parentPattern = new RegExp(
    `^${yamlKeyPattern(parent)}:\\s*(?:#.*)?$`
  );
  const fieldPattern = new RegExp(
    `^\\s+${yamlKeyPattern(field)}:\\s*(.*)$`
  );
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
  const pattern = new RegExp(
    `^${yamlKeyPattern(field)}:\\s*"([^"]*)"\\s*$`,
    "m"
  );
  return text.match(pattern)?.[1] ?? null;
}

function nestedListItems(text, keys) {
  const lines = text.split(/\r?\n/);
  let parentIndex = -1;
  let parentIndent = -1;

  for (const [depth, key] of keys.entries()) {
    if (depth === 0) {
      const pattern = new RegExp(
        `^${yamlKeyPattern(key)}:\\s*(?:#.*)?$`
      );
      parentIndex = lines.findIndex((line) => pattern.test(line));
      if (parentIndex < 0) return [];
      parentIndent = 0;
      continue;
    }

    const pattern = new RegExp(
      `^\\s+${yamlKeyPattern(key)}:\\s*(?:#.*)?$`
    );
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

function nestedMapEntries(text, keys) {
  const lines = text.split(/\r?\n/);
  let parentIndex = -1;
  let parentIndent = -1;

  for (const [depth, key] of keys.entries()) {
    const pattern = depth === 0
      ? new RegExp(`^${yamlKeyPattern(key)}:\\s*(?:#.*)?$`)
      : new RegExp(`^\\s+${yamlKeyPattern(key)}:\\s*(?:#.*)?$`);
    let childIndent;
    let childIndex = -1;
    for (let index = parentIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*(?:#.*)?$/.test(line)) continue;
      const lineIndent = indentation(line);
      if (depth > 0 && lineIndent <= parentIndent) break;
      if (depth > 0 && childIndent === undefined) childIndent = lineIndent;
      if (depth > 0 && lineIndent !== childIndent) continue;
      if (pattern.test(line)) {
        childIndex = index;
        childIndent = lineIndent;
        break;
      }
    }
    if (childIndex < 0) return {};
    parentIndex = childIndex;
    parentIndent = childIndent ?? 0;
  }

  const entries = {};
  let entryIndent;
  for (let index = parentIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const lineIndent = indentation(line);
    if (lineIndent <= parentIndent) break;
    if (entryIndent === undefined) entryIndent = lineIndent;
    if (lineIndent !== entryIndent) continue;
    const match = line.match(
      new RegExp(`^\\s*${yamlKeyCapture}:\\s*(.*)$`)
    );
    if (match) entries[capturedYamlKey(match)] = scalarValue(match[4]);
  }
  return entries;
}

function rootMapKeys(text, field) {
  const lines = text.split(/\r?\n/);
  const parentIndex = lines.findIndex(
    (line) =>
      new RegExp(`^${yamlKeyPattern(field)}:\\s*(?:#.*)?$`).test(line)
  );
  if (parentIndex < 0) return [];

  const keys = [];
  let childIndent;
  for (let index = parentIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const lineIndent = indentation(line);
    if (lineIndent === 0) break;
    if (childIndent === undefined) childIndent = lineIndent;
    if (lineIndent !== childIndent) continue;
    const match = line.match(
      new RegExp(`^\\s*${yamlKeyCapture}:(?:\\s|$)`)
    );
    if (match) keys.push(capturedYamlKey(match));
  }
  return keys;
}

function nestedScalarValue(text, keys) {
  const lines = text.split(/\r?\n/);
  let parentIndex = -1;
  let parentIndent = -1;

  for (const [depth, key] of keys.entries()) {
    const pattern = depth === 0
      ? new RegExp(`^${yamlKeyPattern(key)}:\\s*(.*)$`)
      : new RegExp(`^\\s+${yamlKeyPattern(key)}:\\s*(.*)$`);
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

function hasExactEntries(actual, expected) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every(
      (key, index) =>
        actualKeys[index] === key
        && actual[key] === expected[key]
    );
}

function activeStepBlocks(text) {
  const lines = text.split(/\r?\n/);
  const steps = [];

  for (let index = 0; index < lines.length; index += 1) {
    const stepsLine = lines[index].match(
      new RegExp(`^(\\s*)${yamlKeyPattern("steps")}:\\s*(?:#.*)?$`)
    );
    if (!stepsLine) continue;

    const stepsIndent = stepsLine[1].length;
    let job = null;
    for (let ownerIndex = index - 1; ownerIndex >= 0; ownerIndex -= 1) {
      const ownerLine = lines[ownerIndex];
      if (/^\s*(?:#.*)?$/.test(ownerLine)) continue;
      const ownerIndent = indentation(ownerLine);
      if (ownerIndent < stepsIndent - 2) break;
      if (ownerIndent !== stepsIndent - 2) continue;
      const owner = ownerLine.match(
        new RegExp(`^\\s*${yamlKeyCapture}:\\s*(?:#.*)?$`)
      );
      if (owner) job = capturedYamlKey(owner);
      break;
    }
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

      if (
        new RegExp(
          `^\\s*-\\s+(?:"[^"]+"|'[^']+'|[A-Za-z_][\\w-]*):`
        ).test(line)
      ) {
        if (stepIndent === undefined) stepIndent = lineIndent;
        if (lineIndent === stepIndent) {
          if (current) steps.push(current);
          current = { indent: stepIndent, job, lines: [line] };
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
  const key = yamlKeyPattern(field);
  const firstLine = new RegExp(
    `^\\s{${step.indent}}-\\s+${key}:\\s*(.*)$`
  );
  const otherLine = new RegExp(
    `^\\s{${step.indent + 2}}${key}:\\s*(.*)$`
  );
  for (const [index, line] of step.lines.entries()) {
    if (/^\s*#/.test(line)) continue;
    const match = line.match(index === 0 ? firstLine : otherLine);
    if (match) return scalarValue(match[1]);
  }
  return null;
}

function stepChildField(step, parent, field) {
  const parentPattern = new RegExp(
    `^\\s{${step.indent + 2}}${yamlKeyPattern(parent)}:\\s*(?:#.*)?$`
  );
  const childPattern = new RegExp(
    `^\\s{${step.indent + 4}}${yamlKeyPattern(field)}:\\s*(.*)$`
  );
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
  const fieldPattern = new RegExp(
    `^\\s{${step.indent + 2}}${yamlKeyPattern(field)}:\\s*\\|\\s*$`
  );
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
  const checkoutFetchDepths = [];
  const runCommands = [];
  const runSteps = [];
  const pushPaths = nestedListItems(text, ["on", "push", "paths"]);
  const unsupportedYamlLines = inspectSupportedYamlSubset(text);
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
  const artifactActions = [];
  const artifactSteps = [];
  const steps = [];
  const checkoutRefs = [];
  const activeSource = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const usesRepositorySwaToken =
    /secrets\s*(?:\.\s*AZURE_STATIC_WEB_APPS_API_TOKEN|\[\s*["']AZURE_STATIC_WEB_APPS_API_TOKEN["']\s*\])/i
      .test(activeSource);
  const stepConditions = {};
  const stepOrders = {};
  const stepWorkingDirectories = {};
  let backendDeploymentPackage = null;
  let backendDeploymentReceipt = null;
  const backendDeploymentTargetChecks = [];
  let frontendTokenResolver = null;
  let frontendDeploymentMarker = null;
  const frontendDeploymentOwnershipChecks = [];
  let frontendDeploymentReceipt = null;
  const frontendDeploymentRequeues = [];
  let productionHealthClassification = null;
  let productionHealthClassificationValidation = null;
  let productionHealthCheck = null;
  let productionHealthBackendIdentityCheck = null;
  let productionHealthIdentityCheck = null;
  const concurrency = {
    group: rootChildField(text, "concurrency", "group"),
    cancelInProgress: rootChildField(text, "concurrency", "cancel-in-progress"),
  };
  const workflowPermissions = {
    actions: nestedScalarValue(text, ["permissions", "actions"]),
    contents: nestedScalarValue(text, ["permissions", "contents"]),
    idToken: nestedScalarValue(text, ["permissions", "id-token"]),
  };
  const workflowPermissionEntries = nestedMapEntries(text, ["permissions"]);
  const jobPolicies = rootMapKeys(text, "jobs").map((job) => ({
    actionsPermission: nestedScalarValue(text, [
      "jobs",
      job,
      "permissions",
      "actions",
    ]),
    condition: nestedScalarValue(text, ["jobs", job, "if"]),
    contentsPermission: nestedScalarValue(text, [
      "jobs",
      job,
      "permissions",
      "contents",
    ]),
    continueOnError: nestedScalarValue(text, ["jobs", job, "continue-on-error"]),
    displayName: nestedScalarValue(text, ["jobs", job, "name"]),
    idTokenPermission: nestedScalarValue(text, [
      "jobs",
      job,
      "permissions",
      "id-token",
    ]),
    job,
    needs: nestedScalarValue(text, ["jobs", job, "needs"]),
    permissionEntries: nestedMapEntries(text, ["jobs", job, "permissions"]),
    permissionsMode: nestedScalarValue(text, ["jobs", job, "permissions"]),
  }));

  for (const [order, step] of activeStepBlocks(text).entries()) {
    const name = stepField(step, "name");
    const uses = stepField(step, "uses");
    const run = stepBlockScalar(step, "run") ?? stepField(step, "run");
    steps.push({
      command: run,
      condition: stepField(step, "if"),
      continueOnError: stepField(step, "continue-on-error"),
      job: step.job,
      name,
      order,
      uses,
    });
    if (run) {
      runCommands.push(run);
      runSteps.push({
        command: run,
        condition: stepField(step, "if"),
        continueOnError: stepField(step, "continue-on-error"),
        id: stepField(step, "id"),
        job: step.job,
        name,
        order,
      });
    }
    if (uses?.startsWith("actions/checkout@")) {
      const persistCredentials = stepChildField(step, "with", "persist-credentials");
      const targetPath = stepChildField(step, "with", "path");
      checkoutFetchDepths.push({
        path,
        depth: stepChildField(step, "with", "fetch-depth"),
        job: step.job,
        ...(persistCredentials === null ? {} : { persistCredentials }),
        ...(name === null ? {} : { stepName: name }),
        ...(targetPath === null ? {} : { targetPath }),
      });
    }
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

    if (run === "node scripts/check-workflow-runtime-contracts.mjs") {
      contractInvocations.push(path);
    }

    const staticWebApp = uses?.match(/^azure\/static-web-apps-deploy@(.+)$/i);
    if (staticWebApp) {
      staticWebAppActions.push({
        action: stepChildField(step, "with", "action"),
        path,
        condition: stepField(step, "if"),
        job: step.job,
        productionBranch: stepChildField(step, "with", "production_branch"),
        ref: staticWebApp[1],
        token: stepChildField(step, "with", "azure_static_web_apps_api_token"),
      });
    }

    const artifact = uses?.match(/^actions\/(upload-artifact|download-artifact)@(.+)$/i);
    if (artifact) {
      artifactActions.push({
        action: artifact[1].toLowerCase(),
        condition: stepField(step, "if"),
        ifNoFilesFound: stepChildField(step, "with", "if-no-files-found"),
        job: step.job,
        name: stepChildField(step, "with", "name"),
        path: stepChildField(step, "with", "path"),
        ref: artifact[2],
        retentionDays: stepChildField(step, "with", "retention-days"),
        stepName: name,
        uses,
      });
      artifactSteps.push({
        action: artifact[1].toLowerCase(),
        job: step.job,
        name: stepChildField(step, "with", "name"),
        order,
        path: stepChildField(step, "with", "path"),
      });
    }

    if (name) {
      stepConditions[name] = stepField(step, "if");
      stepOrders[name] = order;
      stepWorkingDirectories[name] = stepField(step, "working-directory");
    }
    if (name === "Create deployment package") {
      backendDeploymentPackage = {
        command: run,
        condition: stepField(step, "if"),
        continueOnError: stepField(step, "continue-on-error"),
        job: step.job,
        order,
      };
    }
    if (name === "Record canonical backend deployment receipt") {
      backendDeploymentReceipt = {
        command: run,
        condition: stepField(step, "if"),
        continueOnError: stepField(step, "continue-on-error"),
        expectedSha: stepChildField(
          step,
          "env",
          "PRODUCTION_BACKEND_DEPLOYED_SHA"
        ),
        job: step.job,
        order,
        scope: stepChildField(step, "env", "PRODUCTION_SMOKE_SCOPE"),
      };
    }
    if (backendTargetStepNames.includes(name)) {
      backendDeploymentTargetChecks.push({
        command: run,
        condition: stepField(step, "if"),
        continueOnError: stepField(step, "continue-on-error"),
        ghToken: stepChildField(step, "env", "GH_TOKEN"),
        job: step.job,
        name,
        order,
        workingDirectory: stepField(step, "working-directory"),
      });
    }
    if (name === "Classify deployment event") {
      productionHealthClassification = {
        condition: stepField(step, "if"),
        ghToken: stepChildField(step, "env", "GH_TOKEN"),
        deploymentConclusion: stepChildField(step, "env", "DEPLOYMENT_CONCLUSION"),
        deploymentEvent: stepChildField(step, "env", "DEPLOYMENT_EVENT"),
        deploymentHeadBranch: stepChildField(step, "env", "DEPLOYMENT_HEAD_BRANCH"),
        deploymentRunId: stepChildField(step, "env", "DEPLOYMENT_RUN_ID"),
        deploymentRunAttempt: stepChildField(step, "env", "DEPLOYMENT_RUN_ATTEMPT"),
        deploymentSha: stepChildField(step, "env", "DEPLOYMENT_SHA"),
        deploymentWorkflow: stepChildField(step, "env", "DEPLOYMENT_WORKFLOW"),
        command: stepField(step, "run"),
      };
    }
    if (name === "Check production") {
      productionHealthCheck = {
        expectedBackendSha: stepChildField(
          step,
          "env",
          "PRODUCTION_BACKEND_DEPLOYED_SHA"
        ),
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
    if (name === "Verify deployed backend identity") {
      productionHealthBackendIdentityCheck = {
        command: run,
        continueOnError: stepField(step, "continue-on-error"),
        expectedSha: stepChildField(
          step,
          "env",
          "PRODUCTION_BACKEND_DEPLOYED_SHA"
        ),
        scope: stepChildField(step, "env", "PRODUCTION_SMOKE_SCOPE"),
      };
    }
    if (name === "Validate deployment classification") {
      productionHealthClassificationValidation = {
        condition: stepField(step, "if"),
        canonicalDeployment: stepChildField(step, "env", "CANONICAL_DEPLOYMENT"),
        deployedSha: stepChildField(step, "env", "DEPLOYED_SHA"),
        deploymentReceipt: stepChildField(step, "env", "DEPLOYMENT_RECEIPT"),
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
        job: step.job,
      };
    }
    if (
      name === "Check deployment ownership"
      || name === "Recheck deployment ownership"
    ) {
      frontendDeploymentOwnershipChecks.push({
        command: stepField(step, "run"),
        condition: stepField(step, "if"),
        ghToken: stepChildField(step, "env", "GITHUB_TOKEN"),
        id: stepField(step, "id"),
        job: step.job,
        name,
      });
    }
    if (name === "Record canonical deployment receipt") {
      frontendDeploymentReceipt = {
        command: stepField(step, "run"),
        condition: stepField(step, "if"),
        ghToken: stepChildField(step, "env", "GITHUB_TOKEN"),
        id: stepField(step, "id"),
        job: step.job,
      };
    }
    if (
      name === "Requeue current main tip after initial check"
      || name === "Requeue current main tip after final check"
      || name === "Requeue current main tip after receipt fence"
    ) {
      frontendDeploymentRequeues.push({
        command: stepField(step, "run"),
        condition: stepField(step, "if"),
        ghToken: stepChildField(step, "env", "GH_TOKEN"),
        job: step.job,
        name,
      });
    }
    if (stepField(step, "id") === "swa_token") {
      frontendTokenResolver = {
        job: step.job,
        source: step.lines.join("\n"),
      };
    }
  }

  return {
    artifactActions,
    artifactSteps,
    steps,
    unsupportedYamlLines,
    azureLoginRefs,
    checkoutRefs,
    setupNodeVersions,
    contractInvocations,
    checkoutFetchDepths,
    runCommands,
    runSteps,
    concurrency,
    jobPolicies,
    workflowPermissions,
    workflowPermissionEntries,
    workflowPermissionsMode: nestedScalarValue(text, ["permissions"]),
    backendDeploymentJob: {
      actionsPermission: nestedScalarValue(text, [
        "jobs",
        "deploy",
        "permissions",
        "actions",
      ]),
      condition: nestedScalarValue(text, ["jobs", "deploy", "if"]),
      contentsPermission: nestedScalarValue(text, [
        "jobs",
        "deploy",
        "permissions",
        "contents",
      ]),
      idTokenPermission: nestedScalarValue(text, [
        "jobs",
        "deploy",
        "permissions",
        "id-token",
      ]),
      needs: nestedScalarValue(text, ["jobs", "deploy", "needs"]),
    },
    backendAuthorizeJob: {
      actionsPermission: nestedScalarValue(text, [
        "jobs",
        "authorize",
        "permissions",
        "actions",
      ]),
      condition: nestedScalarValue(text, ["jobs", "authorize", "if"]),
      contentsPermission: nestedScalarValue(text, [
        "jobs",
        "authorize",
        "permissions",
        "contents",
      ]),
      idTokenPermission: nestedScalarValue(text, [
        "jobs",
        "authorize",
        "permissions",
        "id-token",
      ]),
      needs: nestedScalarValue(text, ["jobs", "authorize", "needs"]),
    },
    backendBuildJob: {
      actionsPermission: nestedScalarValue(text, [
        "jobs",
        "build",
        "permissions",
        "actions",
      ]),
      condition: nestedScalarValue(text, ["jobs", "build", "if"]),
      contentsPermission: nestedScalarValue(text, [
        "jobs",
        "build",
        "permissions",
        "contents",
      ]),
      idTokenPermission: nestedScalarValue(text, [
        "jobs",
        "build",
        "permissions",
        "id-token",
      ]),
      needs: nestedScalarValue(text, ["jobs", "build", "needs"]),
    },
    backendPreflightJob: {
      actionsPermission: nestedScalarValue(text, [
        "jobs",
        "preflight",
        "permissions",
        "actions",
      ]),
      condition: nestedScalarValue(text, ["jobs", "preflight", "if"]),
      contentsPermission: nestedScalarValue(text, [
        "jobs",
        "preflight",
        "permissions",
        "contents",
      ]),
      idTokenPermission: nestedScalarValue(text, [
        "jobs",
        "preflight",
        "permissions",
        "id-token",
      ]),
      needs: nestedScalarValue(text, ["jobs", "preflight", "needs"]),
    },
    backendDeploymentPackage,
    backendDeploymentReceipt,
    backendDeploymentTargetChecks,
    pushPaths,
    runName: quotedRootScalar(text, "run-name"),
    staticWebAppActions,
    stepConditions,
    stepOrders,
    stepWorkingDirectories,
    frontendTokenResolver,
    frontendDeploymentMarker,
    frontendDeploymentOwnershipChecks,
    frontendDeploymentReceipt,
    frontendDeploymentRequeues,
    frontendProductionJob: {
      actionsPermission: nestedScalarValue(text, [
        "jobs",
        "deploy_production",
        "permissions",
        "actions",
      ]),
      condition: nestedScalarValue(text, ["jobs", "deploy_production", "if"]),
      needs: nestedScalarValue(text, ["jobs", "deploy_production", "needs"]),
    },
    productionHealthClassification,
    productionHealthClassificationValidation,
    productionHealthCheck,
    productionHealthBackendIdentityCheck,
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
  const backend = workflows.find((workflow) => workflow.path === backendWorkflow);
  const frontend = workflows.find((workflow) => workflow.path === frontendWorkflow);
  const backendPolicy = backend ? inspectWorkflow(backend.text, backend.path) : null;
  const inspectedFrontend = frontend
    ? inspectWorkflow(frontend.text, frontend.path)
    : null;
  const healthConcurrency = healthWorkflow
    ? inspectWorkflow(healthWorkflow.text, healthWorkflow.path).concurrency
    : null;
  const healthPolicy = healthWorkflow
    ? inspectWorkflow(healthWorkflow.text, healthWorkflow.path)
    : null;
  const frontendPolicy = inspectedFrontend;
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
    for (const workflow of workflows) {
      const unsupportedYamlLines =
        inspectWorkflow(workflow.text, workflow.path).unsupportedYamlLines;
      if (unsupportedYamlLines.length > 0) {
        issues.push(
          `${workflow.path} must use the supported block-style YAML subset without duplicate, explicit, flow-mapping, anchor, alias, or escaped keys (lines ${unsupportedYamlLines.join(", ")})`
        );
      }
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
  if (aggregate.setupNodeVersions.length !== 7) {
    issues.push(`expected seven setup-node steps, found ${aggregate.setupNodeVersions.length}`);
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
  if (!backendPolicy) {
    issues.push(`${backendWorkflow} is missing`);
  } else {
    const backendTargetSteps = backendPolicy.backendDeploymentTargetChecks;
    const backendTargetStepsByName = Object.fromEntries(
      backendTargetSteps.map((step) => [step.name, step])
    );
    const initialBackendTargetStep =
      backendTargetStepsByName[backendRequeueTargetStepNames[0]];
    const authorizationBackendTargetStep =
      backendTargetStepsByName[backendRequeueTargetStepNames[1]];
    const deployPreloginTargetStep =
      backendTargetStepsByName[backendDeployTargetStepNames[0]];
    const deployPreuploadTargetStep =
      backendTargetStepsByName[backendDeployTargetStepNames[1]];
    const backendPolicyTestStep = backendPolicy.runSteps.find(
      (step) => step.name === "Test backend deployment policy"
    );
    const backendLoginOrder = backendPolicy.stepOrders["Azure Login (attempt 1)"];
    const backendDeploymentOrder =
      backendPolicy.stepOrders["Deploy to Azure Functions"];
    const backendArtifactUploads = backendPolicy.artifactActions.filter(
      (action) => action.action === "upload-artifact"
    );
    const backendArtifactDownloads = backendPolicy.artifactActions.filter(
      (action) => action.action === "download-artifact"
    );
    const backendArtifactUpload = backendArtifactUploads[0];
    const backendArtifactDownload = backendArtifactDownloads[0];
    const backendArtifactUploadOrder =
      backendPolicy.stepOrders["Stage backend deployment package"];
    const backendArtifactDownloadOrder =
      backendPolicy.stepOrders["Download backend deployment package"];
    const backendPackageIdentityStep = backendPolicy.runSteps.find(
      (step) => step.name === "Verify deployment package identity"
    );
    const backendDeploymentStep = backendPolicy.runSteps.find(
      (step) => step.name === "Deploy to Azure Functions"
    );
    const backendCorsStep = backendPolicy.runSteps.find(
      (step) => step.name === "Ensure production auth CORS origins"
    );
    const backendDeployTargetCheckout = backendPolicy.checkoutFetchDepths.find(
      (checkout) => checkout.stepName === "Checkout deployment target history"
    );
    const backendStepNames = backendPolicy.steps.map((step) => step.name).sort();
    const expectedBackendStepNames = [...backendRequiredStepNames].sort();
    const backendJobNames = backendPolicy.jobPolicies
      .map((job) => job.job)
      .sort();
    const expectedBackendJobNames = ["authorize", "build", "deploy", "preflight"];
    const expectedBackendPermissions = {
      authorize: { actions: "write", contents: "read" },
      build: { contents: "read" },
      deploy: { contents: "read", "id-token": "write" },
      preflight: { actions: "write", contents: "read" },
    };
    const normalizedBackendPushPaths = [...backendPolicy.pushPaths].sort();
    const normalizedBackendDeploymentPaths =
      [...backendDeploymentTriggerPaths].sort();
    if (
      backendPolicy.concurrency.group !== backendProductionConcurrencyGroup
      || backendPolicy.concurrency.cancelInProgress !== backendCancelInProgress
    ) {
      issues.push(
        `${backendWorkflow} must isolate non-main runs and serialize production without orphaning the latest pending deployment`
      );
    }
    if (
      backendPolicy.backendPreflightJob.condition !== backendProductionJobCondition
      || backendPolicy.backendBuildJob.condition !== backendProductionJobCondition
      || backendPolicy.backendAuthorizeJob.condition !== backendProductionJobCondition
      || backendPolicy.backendDeploymentJob.condition !== backendProductionJobCondition
    ) {
      issues.push(`${backendWorkflow} must block non-main production deployment`);
    }
    if (
      backendJobNames.length !== expectedBackendJobNames.length
      || expectedBackendJobNames.some(
        (job, index) => backendJobNames[index] !== job
      )
      || backendPolicy.workflowPermissions.actions !== null
      || backendPolicy.workflowPermissions.contents !== null
      || backendPolicy.workflowPermissions.idToken !== null
      || backendPolicy.workflowPermissionsMode !== null
      || !hasExactEntries(backendPolicy.workflowPermissionEntries, {})
      || backendPolicy.jobPolicies.some(
        (job) => !hasExactEntries(
          job.permissionEntries,
          expectedBackendPermissions[job.job] ?? {}
        )
      )
      || backendPolicy.backendPreflightJob.needs !== null
      || backendPolicy.backendPreflightJob.actionsPermission !== "write"
      || backendPolicy.backendPreflightJob.contentsPermission !== "read"
      || backendPolicy.backendPreflightJob.idTokenPermission !== null
      || backendPolicy.backendBuildJob.needs !== "preflight"
      || backendPolicy.backendBuildJob.actionsPermission !== null
      || backendPolicy.backendBuildJob.contentsPermission !== "read"
      || backendPolicy.backendBuildJob.idTokenPermission !== null
      || backendPolicy.backendAuthorizeJob.needs !== "build"
      || backendPolicy.backendAuthorizeJob.actionsPermission !== "write"
      || backendPolicy.backendAuthorizeJob.contentsPermission !== "read"
      || backendPolicy.backendAuthorizeJob.idTokenPermission !== null
      || backendPolicy.backendDeploymentJob.needs !== "authorize"
      || backendPolicy.backendDeploymentJob.actionsPermission !== null
      || backendPolicy.backendDeploymentJob.contentsPermission !== "read"
      || backendPolicy.backendDeploymentJob.idTokenPermission !== "write"
    ) {
      issues.push(
        `${backendWorkflow} must keep target/build/authorization unprivileged and grant OIDC only after final authorization`
      );
    }
    if (backendPolicy.jobPolicies.some((job) => job.displayName !== null)) {
      issues.push(
        `${backendWorkflow} must keep stable API job identities for deployment classification`
      );
    }
    if (
      backendPolicy.jobPolicies.some(
        (job) => ![null, "false"].includes(job.continueOnError)
      )
      || backendStepNames.length !== expectedBackendStepNames.length
      || expectedBackendStepNames.some(
        (name, index) => backendStepNames[index] !== name
      )
      || backendPolicy.steps.some(
        (step) => {
          const expected = backendConditionalStepPolicy[step.name];
          if (expected) {
            return step.condition !== expected.condition
              || step.continueOnError !== expected.continueOnError;
          }
          return step.condition !== null
            || ![null, "false"].includes(step.continueOnError);
        }
      )
      || backendDeploymentStep?.job !== "deploy"
    ) {
      issues.push(
        `${backendWorkflow} must run every production step unconditionally and fail hard`
      );
    }
    if (
      normalizedBackendPushPaths.length !== normalizedBackendDeploymentPaths.length
      || normalizedBackendDeploymentPaths.some(
        (path, index) => normalizedBackendPushPaths[index] !== path
      )
    ) {
      issues.push(
        `${backendWorkflow} must keep stale-target paths aligned with Backend push paths`
      );
    }
    if (
      !["preflight", "authorize", "deploy"].every((job) =>
        backendPolicy.checkoutFetchDepths.some(
          (checkout) => checkout.job === job && checkout.depth === "0"
        )
      )
      || backendDeployTargetCheckout?.job !== "deploy"
      || backendDeployTargetCheckout?.targetPath !== ".deployment-target"
      || backendDeployTargetCheckout?.persistCredentials !== "false"
      || backendPolicyTestStep?.command !== backendPolicyTestCommand
      || backendPolicyTestStep.job !== "build"
      || backendPolicyTestStep.condition !== null
      || ![null, "false"].includes(backendPolicyTestStep.continueOnError)
      || !Number.isInteger(backendPolicyTestStep.order)
      || backendTargetSteps.length !== backendTargetStepNames.length
      || backendTargetSteps.some(
        (step) => {
          const deployLocal = backendDeployTargetStepNames.includes(step.name);
          return step.command !== (
            deployLocal ? backendReadOnlyTargetCommand : backendRequeueTargetCommand
          )
          || step.condition !== null
          || ![null, "false"].includes(step.continueOnError)
          || step.ghToken !== (deployLocal ? null : backendTargetToken)
          || step.workingDirectory !== (deployLocal ? ".deployment-target" : null);
        }
      )
      || initialBackendTargetStep?.job !== "preflight"
      || authorizationBackendTargetStep?.job !== "authorize"
      || deployPreloginTargetStep?.job !== "deploy"
      || deployPreuploadTargetStep?.job !== "deploy"
      || !Number.isInteger(initialBackendTargetStep?.order)
      || !Number.isInteger(authorizationBackendTargetStep?.order)
      || !Number.isInteger(deployPreloginTargetStep?.order)
      || !Number.isInteger(deployPreuploadTargetStep?.order)
      || !Number.isInteger(backendPackageIdentityStep?.order)
      || !Number.isInteger(backendLoginOrder)
      || !Number.isInteger(backendDeploymentOrder)
      || initialBackendTargetStep.order >= backendPolicyTestStep.order
      || backendPolicyTestStep.order >= authorizationBackendTargetStep.order
      || authorizationBackendTargetStep.order >= deployPreloginTargetStep.order
      || backendPackageIdentityStep.order >= deployPreloginTargetStep.order
      || deployPreloginTargetStep.order >= backendLoginOrder
      || backendLoginOrder >= deployPreuploadTargetStep.order
      || deployPreuploadTargetStep.order >= backendDeploymentOrder
    ) {
      issues.push(
        `${backendWorkflow} must fence stale Backend revisions, requeue current main from unprivileged jobs, and recheck full history inside every deploy attempt before login and immediately before upload`
      );
    }
    if (
      backendCorsStep?.command !== backendCorsCommand
      || backendCorsStep?.condition !== null
      || ![null, "false"].includes(backendCorsStep?.continueOnError)
      || backendCorsStep?.job !== "deploy"
      || !Number.isInteger(backendCorsStep?.order)
      || !Number.isInteger(backendLoginOrder)
      || !Number.isInteger(deployPreuploadTargetStep?.order)
      || backendCorsStep.order <= backendLoginOrder
      || backendCorsStep.order >= deployPreuploadTargetStep.order
    ) {
      issues.push(
        `${backendWorkflow} must enforce production auth CORS origins before the final deployment target fence`
      );
    }
    if (
      backendPolicy.backendDeploymentPackage?.job !== "build"
      || backendPolicy.backendDeploymentPackage?.condition !== null
      || ![null, "false"].includes(
        backendPolicy.backendDeploymentPackage?.continueOnError
      )
      || backendPolicy.backendDeploymentPackage?.command
        !== backendDeploymentPackageCommand
      || !Number.isInteger(backendPolicy.backendDeploymentPackage?.order)
      || !Number.isInteger(backendDeploymentOrder)
      || backendPolicy.backendDeploymentPackage.order >= backendDeploymentOrder
      || backendArtifactUploads.length !== 1
      || backendArtifactUpload?.uses !== "actions/upload-artifact@v7"
      || backendArtifactUpload?.job !== "build"
      || backendArtifactUpload?.stepName !== "Stage backend deployment package"
      || backendArtifactUpload?.condition !== null
      || backendArtifactUpload?.name !== backendArtifactName
      || backendArtifactUpload?.path !== backendArtifactPath
      || backendArtifactUpload?.ifNoFilesFound !== "error"
      || backendArtifactUpload?.retentionDays !== "1"
      || backendArtifactDownloads.length !== 1
      || backendArtifactDownload?.uses !== "actions/download-artifact@v8"
      || backendArtifactDownload?.job !== "deploy"
      || backendArtifactDownload?.stepName !== "Download backend deployment package"
      || backendArtifactDownload?.condition !== null
      || backendArtifactDownload?.name !== backendArtifactName
      || backendArtifactDownload?.path !== "."
      || backendArtifactDownload?.ifNoFilesFound !== null
      || backendArtifactDownload?.retentionDays !== null
      || backendPackageIdentityStep?.command !== backendPackageIdentityCommand
      || backendPackageIdentityStep?.id !== backendPackageIdentityStepId
      || backendPackageIdentityStep?.job !== "deploy"
      || backendPackageIdentityStep?.condition !== null
      || ![null, "false"].includes(backendPackageIdentityStep?.continueOnError)
      || !Number.isInteger(backendArtifactUploadOrder)
      || !Number.isInteger(backendArtifactDownloadOrder)
      || !Number.isInteger(backendPackageIdentityStep?.order)
      || backendPolicy.backendDeploymentPackage.order >= backendArtifactUploadOrder
      || backendArtifactDownloadOrder >= backendPackageIdentityStep.order
      || backendPackageIdentityStep.order >= backendLoginOrder
    ) {
      issues.push(
        `${backendWorkflow} must hand off one exact-SHA backend package whose production dependencies match the frozen tested graph`
      );
    }
    if (
      backendDeploymentStep?.command !== backendDeploymentCommand
      || backendDeploymentStep?.condition !== null
      || ![null, "false"].includes(backendDeploymentStep?.continueOnError)
      || backendDeploymentStep?.job !== "deploy"
    ) {
      issues.push(
        `${backendWorkflow} must upload the verified backend artifact without changing its digest`
      );
    }
    if (
      backendPolicy.backendDeploymentReceipt?.job !== "deploy"
      || backendPolicy.backendDeploymentReceipt?.condition !== null
      || ![null, "false"].includes(
        backendPolicy.backendDeploymentReceipt?.continueOnError
      )
      || backendPolicy.backendDeploymentReceipt?.command !== backendReceiptCommand
      || backendPolicy.backendDeploymentReceipt?.expectedSha
        !== backendReceiptExpectedSha
      || backendPolicy.backendDeploymentReceipt?.scope !== backendReceiptScope
      || !Number.isInteger(backendPolicy.backendDeploymentReceipt?.order)
      || !Number.isInteger(backendDeploymentOrder)
      || backendPolicy.backendDeploymentReceipt.order <= backendDeploymentOrder
    ) {
      issues.push(
        `${backendWorkflow} must read back an exact-SHA backend deployment receipt after Azure deployment`
      );
    }
  }
  if (!inspectedFrontend) {
    issues.push(`${frontendWorkflow} is missing`);
  } else {
    if (!inspectedFrontend.checkoutFetchDepths.some((checkout) => checkout.depth === "0")) {
      issues.push(`${frontendWorkflow} must fetch full history for pinned bootstrap generations`);
    }
    const retentionStep = inspectedFrontend.runSteps.find(
      (step) => step.command === retentionCommand
    );
    const browserContractStep = inspectedFrontend.runSteps.find(
      (step) => step.command === browserContractCommand
    );
    const frontendArtifactUpload = inspectedFrontend.artifactSteps.find(
      (action) =>
        action.action === "upload-artifact"
        && action.job === "build"
        && action.name === frontendArtifactName
        && action.path === frontendArtifactPath
    );
    if (!retentionStep) {
      issues.push(`${frontendWorkflow} must prepare bounded deployment assets before upload`);
    } else if (
      frontendArtifactUpload
      && (
        retentionStep.condition !== null
        || ![null, "false"].includes(retentionStep.continueOnError)
        || retentionStep.job !== "build"
        || retentionStep.order >= frontendArtifactUpload.order
      )
    ) {
      issues.push(`${frontendWorkflow} must prepare bounded deployment assets unconditionally in build before upload`);
    }
    if (!browserContractStep) {
      issues.push(`${frontendWorkflow} must run the stale deployment browser contracts`);
    } else if (
      frontendArtifactUpload
      && (
        browserContractStep.condition !== null
        || ![null, "false"].includes(browserContractStep.continueOnError)
        || browserContractStep.job !== "build"
        || browserContractStep.order >= frontendArtifactUpload.order
      )
    ) {
      issues.push(`${frontendWorkflow} must run stale deployment browser contracts unconditionally in build before upload`);
    }
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
    || healthPolicy.productionHealthClassification.deploymentRunId
      !== productionHealthClassifierEnv.DEPLOYMENT_RUN_ID
    || healthPolicy.productionHealthClassification.deploymentRunAttempt
      !== productionHealthClassifierEnv.DEPLOYMENT_RUN_ATTEMPT
    || healthPolicy.productionHealthClassification.command !== productionHealthClassifierCommand
  ) {
    issues.push(
      `${productionHealthWorkflow} must pin classifier jobs to the triggering workflow attempt`
    );
  }
  if (
    healthPolicy?.stepConditions["Verify deployed backend identity"]
      !== productionHealthBackendIdentityCondition
    || healthPolicy.stepWorkingDirectories["Verify deployed backend identity"]
      !== ".health-control"
    || healthPolicy.productionHealthBackendIdentityCheck?.expectedSha
      !== "${{ steps.deployment_event.outputs.deployed_sha }}"
    || healthPolicy.productionHealthBackendIdentityCheck?.scope
      !== backendReceiptScope
    || healthPolicy.productionHealthBackendIdentityCheck?.command
      !== backendReceiptCommand
    || ![null, "false"].includes(
      healthPolicy.productionHealthBackendIdentityCheck?.continueOnError
    )
  ) {
    issues.push(
      `${productionHealthWorkflow} must keep a controller-owned backend identity gate`
    );
  }
  const productionHealthWorkflowTestStep = healthPolicy?.runSteps.find(
    (step) => step.name === "Test workflow runtime parser"
  );
  const healthJobNames = (healthPolicy?.jobPolicies ?? [])
    .map((job) => job.job)
    .sort();
  if (
    healthJobNames.length !== 1
    || healthJobNames[0] !== "smoke"
    || healthPolicy?.workflowPermissions.actions !== "read"
    || healthPolicy.workflowPermissions.contents !== "read"
    || healthPolicy.workflowPermissions.idToken !== null
    || healthPolicy.workflowPermissionsMode !== ""
    || !hasExactEntries(healthPolicy.workflowPermissionEntries, {
      actions: "read",
      contents: "read",
    })
    || healthPolicy.jobPolicies.some(
      (job) =>
        job.condition !== null
        || ![null, "false"].includes(job.continueOnError)
        || job.idTokenPermission !== null
        || !hasExactEntries(job.permissionEntries, {})
        || job.permissionsMode !== null
    )
    || healthPolicy.steps.some(
      (step) => ![null, "false"].includes(step.continueOnError)
    )
  ) {
    issues.push(
      `${productionHealthWorkflow} must keep its sole controller job unprivileged and fail hard`
    );
  }
  if (
    productionHealthWorkflowTestStep?.command !== productionHealthWorkflowTestCommand
  ) {
    issues.push(
      `${productionHealthWorkflow} must test Backend target and workflow policies before network health`
    );
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
    || healthPolicy.productionHealthClassification.deploymentRunId
      !== productionHealthClassifierEnv.DEPLOYMENT_RUN_ID
    || healthPolicy.productionHealthClassification.deploymentRunAttempt
      !== productionHealthClassifierEnv.DEPLOYMENT_RUN_ATTEMPT
    || healthPolicy.productionHealthClassification.deploymentSha
      !== productionHealthClassifierEnv.DEPLOYMENT_SHA
    || healthPolicy.productionHealthClassification.deploymentWorkflow
      !== productionHealthClassifierEnv.DEPLOYMENT_WORKFLOW
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
    || healthPolicy.productionHealthClassificationValidation.deploymentReceipt
      !== "${{ steps.deployment_event.outputs.deployment_receipt }}"
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
    || healthPolicy.productionHealthCheck?.expectedBackendSha
      !== productionHealthExpectedBackendSha
  ) {
    issues.push(
      `${productionHealthWorkflow} must checkout and verify the triggering deployed SHA instead of the current main SHA`
    );
  }
  if (!frontendPolicy) {
    issues.push(`${frontendWorkflow} is missing`);
  } else {
    const artifactUploads = frontendPolicy.artifactActions.filter(
      (action) => action.action === "upload-artifact"
    );
    const artifactDownloads = frontendPolicy.artifactActions.filter(
      (action) => action.action === "download-artifact"
    );
    if (
      artifactUploads.length !== 1
      || artifactUploads[0]?.uses !== "actions/upload-artifact@v7"
      || artifactUploads[0]?.job !== "build"
      || artifactUploads[0]?.stepName !== "Stage production artifact"
      || artifactUploads[0]?.condition !== frontendUploadCondition
      || artifactUploads[0]?.name !== frontendArtifactName
      || artifactUploads[0]?.path !== frontendArtifactPath
      || artifactUploads[0]?.ifNoFilesFound !== "error"
      || artifactUploads[0]?.retentionDays !== "1"
    ) {
      issues.push(
        `${frontendWorkflow} must use actions/upload-artifact@v7 with the guarded frontend-dist path and one-day retention`
      );
    }
    if (
      artifactDownloads.length !== 1
      || artifactDownloads[0]?.uses !== "actions/download-artifact@v8"
      || artifactDownloads[0]?.job !== "deploy_production"
      || artifactDownloads[0]?.stepName !== "Download production artifact"
      || artifactDownloads[0]?.condition !== null
      || artifactDownloads[0]?.name !== frontendArtifactName
      || artifactDownloads[0]?.path !== frontendArtifactPath
      || artifactDownloads[0]?.ifNoFilesFound !== null
      || artifactDownloads[0]?.retentionDays !== null
    ) {
      issues.push(
        `${frontendWorkflow} must use actions/download-artifact@v8 to restore frontend-dist at the original cross-job path`
      );
    }
    if (
      frontendPolicy.staticWebAppActions.some(
        (action) => action.productionBranch !== null
      )
    ) {
      issues.push(
        `${frontendWorkflow} must not pass the unsupported production_branch input to Azure/static-web-apps-deploy`
      );
    }
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
      || frontendPolicy.staticWebAppActions[0]?.condition !== frontendActualUploadCondition
      || frontendPolicy.staticWebAppActions[0]?.job !== "deploy_production"
      || frontendPolicy.staticWebAppActions[0]?.ref !== "v1"
      || frontendPolicy.staticWebAppActions[0]?.token !== frontendUploadToken
      || frontendPolicy.frontendProductionJob.condition !== frontendUploadCondition
      || frontendPolicy.frontendProductionJob.actionsPermission !== "write"
      || frontendPolicy.frontendProductionJob.needs !== "build"
      || frontendPolicy.usesRepositorySwaToken
      || !frontendPolicy.frontendTokenResolver
      || frontendPolicy.frontendTokenResolver?.job !== "deploy_production"
      || frontendPolicy.frontendDeploymentMarker?.condition !== frontendUploadCondition
      || frontendPolicy.frontendDeploymentMarker?.command !== frontendDeploymentMarkerCommand
      || frontendPolicy.frontendDeploymentMarker?.job !== "build"
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
    const ownershipChecks = Object.fromEntries(
      frontendPolicy.frontendDeploymentOwnershipChecks.map((check) => [check.name, check])
    );
    if (
      frontendPolicy.frontendDeploymentOwnershipChecks.length !== 2
      || ownershipChecks["Check deployment ownership"]?.id !== "deployment_ownership_initial"
      || ownershipChecks["Check deployment ownership"]?.job !== "deploy_production"
      || ownershipChecks["Check deployment ownership"]?.condition
        !== frontendInitialOwnershipCondition
      || ownershipChecks["Check deployment ownership"]?.ghToken
        !== "${{ secrets.GITHUB_TOKEN }}"
      || ownershipChecks["Check deployment ownership"]?.command !== frontendOwnershipCommand
      || ownershipChecks["Recheck deployment ownership"]?.id !== "deployment_ownership_final"
      || ownershipChecks["Recheck deployment ownership"]?.job !== "deploy_production"
      || ownershipChecks["Recheck deployment ownership"]?.condition
        !== frontendFinalOwnershipCondition
      || ownershipChecks["Recheck deployment ownership"]?.ghToken
        !== "${{ secrets.GITHUB_TOKEN }}"
      || ownershipChecks["Recheck deployment ownership"]?.command !== frontendOwnershipCommand
      || frontendPolicy.frontendDeploymentReceipt?.job !== "deploy_production"
      || frontendPolicy.frontendDeploymentReceipt?.condition !== frontendActualUploadCondition
      || frontendPolicy.frontendDeploymentReceipt?.id !== "canonical_receipt"
      || frontendPolicy.frontendDeploymentReceipt?.ghToken
        !== "${{ secrets.GITHUB_TOKEN }}"
      || frontendPolicy.frontendDeploymentReceipt?.command !== frontendReceiptCommand
    ) {
      issues.push(
        `${frontendWorkflow} must coalesce stale and duplicate production runs with pre-upload ownership checks and a main-tip-fenced deployment receipt`
      );
    }
    const requeueSteps = Object.fromEntries(
      frontendPolicy.frontendDeploymentRequeues.map((step) => [step.name, step])
    );
    if (
      frontendPolicy.frontendDeploymentRequeues.length !== 3
      || requeueSteps["Requeue current main tip after initial check"]?.condition
        !== "steps.deployment_ownership_initial.outputs.reason == 'stale-main'"
      || requeueSteps["Requeue current main tip after final check"]?.condition
        !== "steps.deployment_ownership_final.outputs.reason == 'stale-main'"
      || requeueSteps["Requeue current main tip after receipt fence"]?.condition
        !== "always() && steps.canonical_receipt.outputs.reason == 'stale-main'"
      || frontendPolicy.frontendDeploymentRequeues.some(
        (step) =>
          step.job !== "deploy_production"
          || step.ghToken !== "${{ secrets.GITHUB_TOKEN }}"
          || step.command !== frontendRequeueCommand
      )
    ) {
      issues.push(
        `${frontendWorkflow} must requeue the current main tip when a stale run replaces the only pending production candidate`
      );
    }
  }
  for (const [path, pushPaths] of Object.entries(deployPushPaths)) {
    if (!pushPaths) {
      issues.push(`${path} is missing`);
      continue;
    }
    if (path === frontendWorkflow) {
      if (pushPaths.length !== 0) {
        issues.push(
          `${frontendWorkflow} must run for every main advancement so only the remote main tip can deploy`
        );
      }
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
  const frontendArtifactStage = inspectedFrontend?.artifactSteps.find((step) =>
    step.action === "upload-artifact"
    && step.job === "build"
    && step.name === frontendArtifactName
  );
  for (const requiredCommand of frontendGateCommands) {
    const gate = inspectedFrontend?.runSteps.find((step) =>
      step.job === "build"
      && step.command.includes(requiredCommand)
      && step.condition === null
      && step.continueOnError !== "true"
    );
    if (!gate) {
      issues.push(`${frontendWorkflow} must execute frontend gate command ${requiredCommand}`);
    } else if (!frontendArtifactStage || gate.order >= frontendArtifactStage.order) {
      issues.push(
        `${frontendWorkflow} must execute frontend gate command ${requiredCommand} before artifact staging`
      );
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
    `Workflow runtime contract passed: azure-login=${result.azureLoginRefs.length}@v3 setup-node=${result.setupNodeVersions.length}@v7/node24 enforced-by=${result.contractInvocations.length} health-cancel-stale=${result.healthConcurrency.cancelInProgress} frontend-production=main-tip+serialized+coalesced frontend-dispatch=validation-guarded backend-production=relevant-tip+serialized+receipt backend-runtime-paths=${backendDeploymentPaths.length} backend-algorithm-runtime-paths=${runtimeAlgorithmPaths.length}`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main();
}

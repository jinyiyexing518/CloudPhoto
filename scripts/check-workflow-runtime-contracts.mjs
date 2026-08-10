#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = dirname(dirname(scriptPath));
const workflowDir = join(root, ".github", "workflows");
const requiredContractWorkflows = [
  ".github/workflows/deploy-backend.yml",
  ".github/workflows/production-health.yml",
  ".github/workflows/sync-changelog.yml",
];
const productionHealthWorkflow = ".github/workflows/production-health.yml";
const productionHealthConcurrencyGroup =
  "production-health-${{ github.event_name == 'workflow_run' && github.event.workflow_run.conclusion != 'success' && format('failure-{0}', github.event.workflow_run.id) || 'latest' }}";
const deployWorkflows = [
  ".github/workflows/deploy-backend.yml",
  ".github/workflows/deploy-frontend.yml",
];
const runtimeAlgorithmPaths = [
  "packages/algorithm/src/**",
  "packages/algorithm/package.json",
  "packages/algorithm/tsconfig.json",
];

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

export function inspectWorkflow(text, path = "workflow.yml") {
  const azureLoginRefs = [];
  const setupNodeVersions = [];
  const contractInvocations = [];
  const pushPaths = nestedListItems(text, ["on", "push", "paths"]);
  const concurrency = {
    group: rootChildField(text, "concurrency", "group"),
    cancelInProgress: rootChildField(text, "concurrency", "cancel-in-progress"),
  };

  for (const step of activeStepBlocks(text)) {
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

    if (stepField(step, "run") === "node scripts/check-workflow-runtime-contracts.mjs") {
      contractInvocations.push(path);
    }
  }

  return {
    azureLoginRefs,
    setupNodeVersions,
    contractInvocations,
    concurrency,
    pushPaths,
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
  if (aggregate.azureLoginRefs.length !== 4) {
    issues.push(`expected four Azure login steps, found ${aggregate.azureLoginRefs.length}`);
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

  return { ...aggregate, healthConcurrency, deployPushPaths, issues };
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
    `Workflow runtime contract passed: azure-login=${result.azureLoginRefs.length}@v3 setup-node=${result.setupNodeVersions.length}@v7/node24 enforced-by=${result.contractInvocations.length} health-cancel-stale=${result.healthConcurrency.cancelInProgress} algorithm-runtime-paths=${runtimeAlgorithmPaths.length}x${deployWorkflows.length}`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main();
}

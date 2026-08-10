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

function indentation(line) {
  return line.match(/^\s*/)[0].length;
}

function scalarValue(value) {
  const trimmed = value.replace(/\s+#.*$/, "").trim();
  const quoted = trimmed.match(/^(["'])(.*)\1$/);
  return quoted ? quoted[2] : trimmed;
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

  for (const step of activeStepBlocks(text)) {
    const uses = stepField(step, "uses");
    const azureLogin = uses?.match(/^azure\/login@(.+)$/);
    if (azureLogin) {
      azureLoginRefs.push({ path, version: azureLogin[1] });
    }

    if (uses?.startsWith("actions/setup-node@")) {
      setupNodeVersions.push({
        path,
        version: stepChildField(step, "with", "node-version"),
      });
    }

    if (stepField(step, "run") === "node scripts/check-workflow-runtime-contracts.mjs") {
      contractInvocations.push(path);
    }
  }

  return { azureLoginRefs, setupNodeVersions, contractInvocations };
}

export function checkWorkflowRuntimeContracts(workflows) {
  const issues = [];
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

  return { ...aggregate, issues };
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
    `Workflow runtime contract passed: azure-login=${result.azureLoginRefs.length}@v3 setup-node=${result.setupNodeVersions.length}@24 enforced-by=${result.contractInvocations.length}`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main();
}

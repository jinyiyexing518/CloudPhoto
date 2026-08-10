#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const frontendWorkflow = "Deploy Frontend (Azure Static Web Apps)";

export function classifyDeploymentStarted(workflowName, payload) {
  if (workflowName !== frontendWorkflow) return true;
  if (!Array.isArray(payload?.jobs)) {
    throw new TypeError("GitHub jobs response must contain a jobs array");
  }

  return payload.jobs.some(
    (job) =>
      job?.name === "Deploy production"
      && typeof job.started_at === "string"
      && job.started_at.length > 0
      && job.conclusion !== "skipped"
  );
}

function workflowArgument(argv) {
  const index = argv.indexOf("--workflow");
  if (index < 0 || !argv[index + 1]) {
    throw new Error("--workflow is required");
  }
  return argv[index + 1];
}

function main() {
  const workflowName = workflowArgument(process.argv.slice(2));
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const deploymentStarted = classifyDeploymentStarted(workflowName, payload);
  process.stdout.write(`deployment_started=${deploymentStarted}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main();
}

#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const frontendWorkflow = ".github/workflows/deploy-frontend.yml";
const backendWorkflow = ".github/workflows/deploy-backend.yml";
const commitShaPattern = /^[0-9a-f]{40}$/i;

export function classifyDeploymentStarted(workflowName, payload) {
  if (workflowName === backendWorkflow) return true;
  if (workflowName !== frontendWorkflow) {
    throw new Error(`Unsupported deployment workflow: ${workflowName}`);
  }
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

export function classifyDeploymentEvent({
  workflowName,
  workflowEvent,
  headBranch,
  headSha,
  conclusion,
  jobs,
}) {
  const deploymentStarted = classifyDeploymentStarted(workflowName, { jobs });
  const deployedSha = commitShaPattern.test(headSha ?? "")
    ? headSha.toLowerCase()
    : "";
  const canonicalDeployment = (
    deploymentStarted
    && headBranch === "main"
    && (workflowEvent === "push" || workflowEvent === "workflow_dispatch")
    && deployedSha.length > 0
  );

  return {
    canonicalDeployment,
    deployedSha,
    deploymentStarted,
    shouldCheck: canonicalDeployment && conclusion === "success",
    shouldReject: deploymentStarted && (
      !canonicalDeployment || conclusion !== "success"
    ),
  };
}

function requiredArgument(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) {
    throw new Error(`${name} is required`);
  }
  return argv[index + 1];
}

function main() {
  const argv = process.argv.slice(2);
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const result = classifyDeploymentEvent({
    workflowName: requiredArgument(argv, "--workflow"),
    workflowEvent: requiredArgument(argv, "--event"),
    headBranch: requiredArgument(argv, "--head-branch"),
    headSha: requiredArgument(argv, "--head-sha"),
    conclusion: requiredArgument(argv, "--conclusion"),
    jobs: payload.jobs,
  });
  process.stdout.write([
    `canonical_deployment=${result.canonicalDeployment}`,
    `deployed_sha=${result.deployedSha}`,
    `deployment_started=${result.deploymentStarted}`,
    `should_check=${result.shouldCheck}`,
    `should_reject=${result.shouldReject}`,
    "",
  ].join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main();
}

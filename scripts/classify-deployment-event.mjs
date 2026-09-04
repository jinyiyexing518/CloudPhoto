#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFrontendDeploymentJob } from "./check-frontend-deployment-ownership.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const frontendWorkflow = ".github/workflows/deploy-frontend.yml";
const backendWorkflow = ".github/workflows/deploy-backend.yml";
const commitShaPattern = /^[0-9a-f]{40}$/i;
const backendDeployJobName = "deploy";
const backendUploadStepName = "Deploy to Azure Functions";
const backendReceiptStepName = "Record canonical backend deployment receipt";

function isStartedStep(step) {
  return typeof step?.conclusion === "string" && step.conclusion !== "skipped";
}

export function classifyBackendDeploymentJob(payload) {
  if (!Array.isArray(payload?.jobs)) {
    throw new TypeError("GitHub jobs response must contain a jobs array");
  }
  const deployJobs = payload.jobs.filter((job) => job?.name === backendDeployJobName);
  if (deployJobs.length === 0) {
    return { deploymentReceipt: false, deploymentStarted: false };
  }
  if (deployJobs.length !== 1) {
    throw new Error(`Expected one ${backendDeployJobName} job, found ${deployJobs.length}`);
  }
  const deployJob = deployJobs[0];
  const jobStarted = (
    typeof deployJob.started_at === "string"
    && deployJob.started_at.length > 0
    && deployJob.conclusion !== "skipped"
  );
  if (!jobStarted) {
    return { deploymentReceipt: false, deploymentStarted: false };
  }
  const steps = Array.isArray(deployJob.steps) ? deployJob.steps : [];
  const uploadStep = steps.find((step) => step?.name === backendUploadStepName);
  const receiptStep = steps.find((step) => step?.name === backendReceiptStepName);
  if (!uploadStep) {
    return { deploymentReceipt: false, deploymentStarted: true };
  }
  const deploymentStarted = isStartedStep(uploadStep);
  return {
    deploymentReceipt: (
      uploadStep.conclusion === "success"
      && receiptStep?.conclusion === "success"
    ),
    deploymentStarted,
  };
}

export function classifyDeploymentStarted(workflowName, payload) {
  if (workflowName === backendWorkflow) {
    return classifyBackendDeploymentJob(payload).deploymentStarted;
  }
  if (workflowName !== frontendWorkflow) {
    throw new Error(`Unsupported deployment workflow: ${workflowName}`);
  }
  return classifyFrontendDeploymentJob(payload).deploymentStarted;
}

export function classifyDeploymentEvent({
  workflowName,
  workflowEvent,
  headBranch,
  headSha,
  conclusion,
  jobs,
}) {
  if (workflowName !== frontendWorkflow && workflowName !== backendWorkflow) {
    throw new Error(`Unsupported deployment workflow: ${workflowName}`);
  }
  const deployment = workflowName === frontendWorkflow
    ? classifyFrontendDeploymentJob({ jobs })
    : classifyBackendDeploymentJob({ jobs });
  const { deploymentReceipt, deploymentStarted } = deployment;
  const deployedSha = commitShaPattern.test(headSha ?? "")
    ? headSha.toLowerCase()
    : "";
  const canonicalDeployment = (
    deploymentStarted
    && deploymentReceipt
    && headBranch === "main"
    && (workflowEvent === "push" || workflowEvent === "workflow_dispatch")
    && deployedSha.length > 0
  );
  const successfulBackendTargetWithoutDeployment = (
    workflowName === backendWorkflow
    && !deploymentStarted
    && conclusion === "success"
    && headBranch === "main"
    && (workflowEvent === "push" || workflowEvent === "workflow_dispatch")
    && deployedSha.length > 0
  );

  return {
    canonicalDeployment,
    deployedSha,
    deploymentReceipt,
    deploymentStarted,
    shouldCheck: canonicalDeployment && conclusion === "success",
    shouldReject: successfulBackendTargetWithoutDeployment || (
      deploymentStarted
      && (!canonicalDeployment || conclusion !== "success")
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
    `deployment_receipt=${result.deploymentReceipt}`,
    `deployment_started=${result.deploymentStarted}`,
    `should_check=${result.shouldCheck}`,
    `should_reject=${result.shouldReject}`,
    "",
  ].join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main();
}

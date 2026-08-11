#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const commitShaPattern = /^[0-9a-f]{40}$/i;

export const frontendWorkflowPath = ".github/workflows/deploy-frontend.yml";
export const frontendDeployJobName = "Deploy production";
export const frontendUploadStepName = "Deploy to Azure Static Web Apps";
export const frontendReceiptStepName = "Record canonical deployment receipt";
export const deploymentMarkerUrls = [
  "https://cloudphotos.top/deployment.json",
  "https://brave-sand-053b07a00.7.azurestaticapps.net/deployment.json",
];

function isStartedStep(step) {
  return typeof step?.conclusion === "string" && step.conclusion !== "skipped";
}

export function classifyFrontendDeploymentJob(payload) {
  if (!Array.isArray(payload?.jobs)) {
    throw new TypeError("GitHub jobs response must contain a jobs array");
  }

  const deployJobs = payload.jobs.filter((job) => job?.name === frontendDeployJobName);
  if (deployJobs.length === 0) {
    return { deploymentReceipt: false, deploymentStarted: false };
  }
  if (deployJobs.length !== 1) {
    throw new Error(`Expected one ${frontendDeployJobName} job, found ${deployJobs.length}`);
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
  const uploadStep = steps.find((step) => step?.name === frontendUploadStepName);
  const receiptStep = steps.find((step) => step?.name === frontendReceiptStepName);
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

export function parseDeploymentMarker({ body, cacheControl, origin }) {
  const cacheDirectives = String(cacheControl ?? "")
    .split(",")
    .map((directive) => directive.trim().toLowerCase());
  if (!cacheDirectives.includes("no-store")) {
    throw new Error(`Deployment marker is cacheable for ${origin}`);
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`Deployment marker is not valid JSON for ${origin}`);
  }
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || Object.keys(payload).length !== 1
    || !commitShaPattern.test(payload.sha ?? "")
  ) {
    throw new Error(`Deployment marker has an invalid shape for ${origin}`);
  }
  return payload.sha.toLowerCase();
}

export async function checkCurrentMainOwnership({
  expectedSha,
  repository,
  requestJson,
}) {
  if (!commitShaPattern.test(expectedSha ?? "")) {
    throw new Error("GITHUB_SHA must be a 40-character commit SHA");
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository ?? "")) {
    throw new Error("GITHUB_REPOSITORY must use owner/repository form");
  }
  const normalizedSha = expectedSha.toLowerCase();
  const mainRef = await requestJson(`/repos/${repository}/git/ref/heads/main`);
  const remoteMainSha = mainRef?.object?.sha?.toLowerCase();
  if (!commitShaPattern.test(remoteMainSha ?? "")) {
    throw new Error("GitHub main ref response did not contain a valid commit SHA");
  }
  return {
    reason: remoteMainSha === normalizedSha ? "owned" : "stale-main",
    receiptRunAttempt: "",
    receiptRunId: "",
    shouldDeploy: remoteMainSha === normalizedSha,
  };
}

async function defaultReadDeploymentMarker(url, expectedSha) {
  const markerUrl = new URL(url);
  markerUrl.searchParams.set("sha", expectedSha);
  markerUrl.searchParams.set("ownership", Date.now().toString(36));
  const response = await fetch(markerUrl, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" },
  });
  if (!response.ok) {
    throw new Error(`Deployment marker request failed with ${response.status} for ${markerUrl.origin}`);
  }
  return parseDeploymentMarker({
    body: await response.text(),
    cacheControl: response.headers.get("cache-control"),
    origin: markerUrl.origin,
  });
}

async function receiptDecision({
  expectedSha,
  markerAttempts,
  markerDelayMs,
  readDeploymentMarker,
  receiptRunAttempt,
  receiptRunId,
  sleep,
}) {
  let markerShas = [];
  for (let attempt = 1; attempt <= markerAttempts; attempt += 1) {
    markerShas = await Promise.all(
      deploymentMarkerUrls.map((url) => readDeploymentMarker(url, expectedSha))
    );
    if (markerShas.every((sha) => sha === expectedSha)) {
      return {
        reason: "already-deployed",
        receiptRunAttempt: String(receiptRunAttempt),
        receiptRunId: String(receiptRunId),
        shouldDeploy: false,
      };
    }
    if (attempt < markerAttempts) {
      await sleep(markerDelayMs);
    }
  }

  return {
    reason: "deployment-drift",
    receiptRunAttempt: String(receiptRunAttempt),
    receiptRunId: String(receiptRunId),
    shouldDeploy: true,
  };
}

function assertInputs({ currentRunAttempt, currentRunId, expectedSha, repository }) {
  if (!commitShaPattern.test(expectedSha ?? "")) {
    throw new Error("GITHUB_SHA must be a 40-character commit SHA");
  }
  if (!/^[1-9]\d*$/.test(String(currentRunId ?? ""))) {
    throw new Error("GITHUB_RUN_ID must be a positive integer");
  }
  if (!/^[1-9]\d*$/.test(String(currentRunAttempt ?? ""))) {
    throw new Error("GITHUB_RUN_ATTEMPT must be a positive integer");
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository ?? "")) {
    throw new Error("GITHUB_REPOSITORY must use owner/repository form");
  }
}

export async function checkDeploymentOwnership({
  currentRunAttempt,
  currentRunId,
  expectedSha,
  markerAttempts = 4,
  markerDelayMs = 5_000,
  readDeploymentMarker = defaultReadDeploymentMarker,
  repository,
  requestJson,
  sleep = (milliseconds) => new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds)),
}) {
  assertInputs({ currentRunAttempt, currentRunId, expectedSha, repository });
  if (!Number.isInteger(markerAttempts) || markerAttempts < 1 || markerAttempts > 12) {
    throw new Error("markerAttempts must be an integer between 1 and 12");
  }
  if (!Number.isInteger(markerDelayMs) || markerDelayMs < 0 || markerDelayMs > 30_000) {
    throw new Error("markerDelayMs must be an integer between 0 and 30000");
  }
  const normalizedSha = expectedSha.toLowerCase();
  const mainOwnership = await checkCurrentMainOwnership({
    expectedSha,
    repository,
    requestJson,
  });
  if (!mainOwnership.shouldDeploy) {
    return mainOwnership;
  }

  const normalizedRunAttempt = Number(currentRunAttempt);
  for (let attempt = 1; attempt < normalizedRunAttempt; attempt += 1) {
    const jobs = await requestJson(
      `/repos/${repository}/actions/runs/${currentRunId}/attempts/${attempt}/jobs?per_page=100`
    );
    if (classifyFrontendDeploymentJob(jobs).deploymentReceipt) {
      return receiptDecision({
        expectedSha: normalizedSha,
        markerAttempts,
        markerDelayMs,
        readDeploymentMarker,
        receiptRunAttempt: attempt,
        receiptRunId: String(currentRunId),
        sleep,
      });
    }
  }

  let completedRunScan = false;
  let expectedRunCount = null;
  let inspectedRunCount = 0;
  for (let page = 1; page <= 10; page += 1) {
    const query = new URLSearchParams({
      branch: "main",
      exclude_pull_requests: "true",
      head_sha: normalizedSha,
      page: String(page),
      per_page: "100",
    });
    const runsPayload = await requestJson(
      `/repos/${repository}/actions/workflows/deploy-frontend.yml/runs?${query}`
    );
    if (!Array.isArray(runsPayload?.workflow_runs)) {
      throw new TypeError("GitHub workflow runs response must contain a workflow_runs array");
    }
    if (page === 1) {
      if (!Number.isInteger(runsPayload.total_count) || runsPayload.total_count < 0) {
        throw new TypeError("GitHub workflow runs response must contain a non-negative total_count");
      }
      if (runsPayload.total_count > 1_000) {
        throw new Error("Successful same-SHA workflow run scan exceeds GitHub's 1000-result limit");
      }
      expectedRunCount = runsPayload.total_count;
    }
    inspectedRunCount += runsPayload.workflow_runs.length;

    const candidates = runsPayload.workflow_runs.filter((run) => (
      String(run?.id) !== String(currentRunId)
      && (run?.event === "push" || run?.event === "workflow_dispatch")
      && run?.head_branch === "main"
      && run?.head_sha?.toLowerCase() === normalizedSha
      && run?.path === frontendWorkflowPath
      && Number.isInteger(run?.run_attempt)
      && run.run_attempt > 0
    ));

    for (const run of candidates) {
      for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
        const jobs = await requestJson(
          `/repos/${repository}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`
        );
        if (classifyFrontendDeploymentJob(jobs).deploymentReceipt) {
          return receiptDecision({
            expectedSha: normalizedSha,
            markerAttempts,
            markerDelayMs,
            readDeploymentMarker,
            receiptRunAttempt: attempt,
            receiptRunId: run.id,
            sleep,
          });
        }
      }
    }
    if (inspectedRunCount >= expectedRunCount) {
      completedRunScan = true;
      break;
    }
    if (runsPayload.workflow_runs.length !== 100) {
      throw new Error("GitHub workflow runs pagination ended before total_count");
    }
  }
  if (!completedRunScan) {
    throw new Error("Successful same-SHA workflow run scan did not reach total_count");
  }

  return {
    reason: "owned",
    receiptRunAttempt: "",
    receiptRunId: "",
    shouldDeploy: true,
  };
}

async function githubRequestJson(path) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(new URL(path, apiUrl), {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with ${response.status} for ${path.split("?")[0]}`);
  }
  return response.json();
}

async function main() {
  const confirmsCurrentMain = process.argv.slice(2).includes("--confirm-current-main");
  const result = confirmsCurrentMain
    ? await checkCurrentMainOwnership({
        expectedSha: process.env.GITHUB_SHA,
        repository: process.env.GITHUB_REPOSITORY,
        requestJson: githubRequestJson,
      })
    : await checkDeploymentOwnership({
        currentRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
        currentRunId: process.env.GITHUB_RUN_ID,
        expectedSha: process.env.GITHUB_SHA,
        markerAttempts: 4,
        markerDelayMs: 5_000,
        repository: process.env.GITHUB_REPOSITORY,
        requestJson: githubRequestJson,
      });
  if (!process.env.GITHUB_OUTPUT) {
    throw new Error("GITHUB_OUTPUT is required");
  }

  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `should_deploy=${result.shouldDeploy}`,
      `reason=${result.reason}`,
      `receipt_run_attempt=${result.receiptRunAttempt}`,
      `receipt_run_id=${result.receiptRunId}`,
      "",
    ].join("\n")
  );
  const detail = result.receiptRunId
    ? `; receipt run ${result.receiptRunId} attempt ${result.receiptRunAttempt}`
    : "";
  console.log(`::notice::Frontend deployment ownership: ${result.reason}${detail}.`);
  if (confirmsCurrentMain && result.shouldDeploy) {
    console.log(
      `::notice::Canonical frontend deployment receipt for ${process.env.GITHUB_SHA} from run ${process.env.GITHUB_RUN_ID} attempt ${process.env.GITHUB_RUN_ATTEMPT}.`
    );
  } else if (confirmsCurrentMain) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  await main();
}

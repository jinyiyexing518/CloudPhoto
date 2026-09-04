#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = dirname(dirname(scriptPath));
const commitShaPattern = /^[0-9a-f]{40}$/;
const mainRef = "refs/remotes/origin/main";
const repositorySegmentPattern = /^[A-Za-z0-9_.-]+$/;

export const backendDeploymentPaths = [
  ".github/workflows/deploy-backend.yml",
  ".github/workflows/production-health.yml",
  "packages/algorithm/src",
  "packages/algorithm/package.json",
  "packages/algorithm/tsconfig.json",
  "packages/server",
  "package.json",
  "yarn.lock",
  "scripts/check-backend-deployment-target.mjs",
  "scripts/check-backend-package-dependencies.mjs",
  "scripts/check-frontend-deployment-ownership.mjs",
  "scripts/check-workflow-runtime-contracts.mjs",
  "scripts/classify-deployment-event.mjs",
  "scripts/png-contract.mjs",
  "scripts/production-smoke.mjs",
];
const backendDeploymentDirectories = new Set([
  "packages/algorithm/src",
  "packages/server",
]);
export const backendDeploymentTriggerPaths = backendDeploymentPaths.map(
  (path) => backendDeploymentDirectories.has(path) ? `${path}/**` : path
);

function requireCommitSha(value, name) {
  if (typeof value !== "string" || !commitShaPattern.test(value)) {
    throw new Error(`${name} must be a canonical lowercase 40-character commit SHA`);
  }
  return value;
}

export class BackendDeploymentTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackendDeploymentTargetError";
  }
}

export function validateBackendDeploymentTarget({
  deploymentSha,
  deploymentIsAncestor,
  laterRelevantCommit,
  mainSha,
}) {
  const canonicalDeploymentSha = requireCommitSha(deploymentSha, "deploymentSha");
  const canonicalMainSha = requireCommitSha(mainSha, "mainSha");
  if (deploymentIsAncestor !== true) {
    throw new BackendDeploymentTargetError(
      `Backend deployment ${canonicalDeploymentSha} is not an ancestor of current main ${canonicalMainSha}`,
    );
  }
  if (laterRelevantCommit) {
    const canonicalLaterCommit = requireCommitSha(
      laterRelevantCommit,
      "laterRelevantCommit",
    );
    throw new BackendDeploymentTargetError(
      `Backend deployment ${canonicalDeploymentSha} was superseded by Backend-relevant commit ${canonicalLaterCommit}`,
    );
  }
  return {
    deploymentSha: canonicalDeploymentSha,
    mainSha: canonicalMainSha,
  };
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Unable to run ${command} ${args[0]}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0]} failed with status ${result.status ?? "unknown"}`,
    );
  }
  return result.stdout.trim();
}

function runGit(args, allowedStatuses = [0]) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Unable to run git ${args[0]}: ${result.error.message}`);
  }
  if (!allowedStatuses.includes(result.status)) {
    throw new Error(`git ${args[0]} failed with status ${result.status ?? "unknown"}`);
  }
  return {
    output: result.stdout.trim(),
    status: result.status,
  };
}

export function createBackendRequeueCommand({ hasToken, repository }) {
  const segments = typeof repository === "string" ? repository.split("/") : [];
  if (
    segments.length !== 2
    || segments.some(
      (segment) =>
        !repositorySegmentPattern.test(segment)
        || segment === "."
        || segment === ".."
    )
  ) {
    throw new Error("GITHUB_REPOSITORY must identify the current owner/repository");
  }
  if (!hasToken) {
    throw new Error("GH_TOKEN is required to requeue the current Backend deployment");
  }
  return [
    "workflow",
    "run",
    "deploy-backend.yml",
    "--repo",
    repository,
    "--ref",
    "main",
  ];
}

function requeueCurrentMain() {
  const repository = process.env.GITHUB_REPOSITORY;
  runCommand("gh", createBackendRequeueCommand({
    hasToken: Boolean(process.env.GH_TOKEN),
    repository,
  }));
  process.stdout.write(
    "::notice::Requeued the current main Backend deployment after rejecting a stale candidate.\n",
  );
}

function main() {
  const deploymentSha = requireCommitSha(
    process.env.GITHUB_SHA,
    "GITHUB_SHA",
  );
  runGit([
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  const mainSha = runGit(["rev-parse", mainRef]).output;
  const deploymentIsAncestor = runGit(
    ["merge-base", "--is-ancestor", deploymentSha, mainRef],
    [0, 1],
  ).status === 0;
  const laterRelevantCommit = runGit([
    "rev-list",
    "--max-count=1",
    `${deploymentSha}..${mainRef}`,
    "--",
    ...backendDeploymentPaths,
  ]).output;
  let target;
  try {
    target = validateBackendDeploymentTarget({
      deploymentSha,
      deploymentIsAncestor,
      laterRelevantCommit,
      mainSha,
    });
  } catch (error) {
    if (
      error instanceof BackendDeploymentTargetError
      && process.argv.includes("--requeue-current")
    ) {
      requeueCurrentMain();
    }
    throw error;
  }
  process.stdout.write(
    `::notice::Backend deployment target ${target.deploymentSha} remains current for ${target.mainSha}.\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = 1;
  }
}

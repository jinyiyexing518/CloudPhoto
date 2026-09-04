import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  validateBackendPackageGraph,
  validateLockedPackageTarball,
} from "./check-backend-package-dependencies.mjs";
import {
  BackendDeploymentTargetError,
  backendDeploymentPaths,
  backendDeploymentTriggerPaths,
  createBackendRequeueCommand,
  validateBackendDeploymentTarget,
} from "./check-backend-deployment-target.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("accepts the current main Backend deployment target", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(validateBackendDeploymentTarget({
    deploymentSha: sha,
    deploymentIsAncestor: true,
    laterRelevantCommit: "",
    mainSha: sha,
  }), {
    deploymentSha: sha,
    mainSha: sha,
  });
});

test("allows later commits that do not change Backend deployment inputs", () => {
  assert.deepEqual(validateBackendDeploymentTarget({
    deploymentSha: "a".repeat(40),
    deploymentIsAncestor: true,
    laterRelevantCommit: "",
    mainSha: "b".repeat(40),
  }), {
    deploymentSha: "a".repeat(40),
    mainSha: "b".repeat(40),
  });
});

test("rejects a historical target after a later Backend-relevant commit", () => {
  assert.throws(
    () => validateBackendDeploymentTarget({
      deploymentSha: "a".repeat(40),
      deploymentIsAncestor: true,
      laterRelevantCommit: "b".repeat(40),
      mainSha: "c".repeat(40),
    }),
    (error) => (
      error instanceof BackendDeploymentTargetError
      && /superseded by Backend-relevant commit b{40}/.test(error.message)
    ),
  );
});

test("rejects rewritten history and malformed commit identities", () => {
  assert.throws(
    () => validateBackendDeploymentTarget({
      deploymentSha: "a".repeat(40),
      deploymentIsAncestor: false,
      laterRelevantCommit: "",
      mainSha: "b".repeat(40),
    }),
    (error) => (
      error instanceof BackendDeploymentTargetError
      && /not an ancestor of current main/.test(error.message)
    ),
  );
  for (const deploymentSha of ["", "A".repeat(40), "a".repeat(39)]) {
    assert.throws(
      () => validateBackendDeploymentTarget({
        deploymentSha,
        deploymentIsAncestor: true,
        laterRelevantCommit: "",
        mainSha: "b".repeat(40),
      }),
      /canonical lowercase 40-character commit SHA/,
    );
  }
});

test("tracks every path that can change the Backend deployment artifact", () => {
  assert.deepEqual(backendDeploymentPaths, [
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
  ]);
  assert.deepEqual(backendDeploymentTriggerPaths, [
    ".github/workflows/deploy-backend.yml",
    ".github/workflows/production-health.yml",
    "packages/algorithm/src/**",
    "packages/algorithm/package.json",
    "packages/algorithm/tsconfig.json",
    "packages/server/**",
    "package.json",
    "yarn.lock",
    "scripts/check-backend-deployment-target.mjs",
    "scripts/check-backend-package-dependencies.mjs",
    "scripts/check-frontend-deployment-ownership.mjs",
    "scripts/check-workflow-runtime-contracts.mjs",
    "scripts/classify-deployment-event.mjs",
    "scripts/png-contract.mjs",
    "scripts/production-smoke.mjs",
  ]);
});

test("requires every staged dependency version to come from the tested graph", () => {
  assert.deepEqual(validateBackendPackageGraph({
    dependencies: { "@scope/direct": "^1.0.0", direct: "^2.0.0" },
    stagedPackages: new Set(["@scope/direct@1.1.0", "direct@2.1.0", "transitive@3.0.0"]),
    testedPackages: new Set([
      "@scope/direct@1.1.0",
      "direct@2.1.0",
      "transitive@3.0.0",
    ]),
  }), ["@scope/direct@1.1.0", "direct@2.1.0", "transitive@3.0.0"]);
  assert.throws(
    () => validateBackendPackageGraph({
      dependencies: { direct: "^2.0.0" },
      stagedPackages: new Set(["direct@2.2.0"]),
      testedPackages: new Set(["direct@2.1.0"]),
    }),
    /absent from the frozen tested graph/,
  );
  assert.throws(
    () => validateBackendPackageGraph({
      dependencies: { direct: "^2.0.0" },
      stagedPackages: new Set(),
      testedPackages: new Set(["direct@2.1.0"]),
    }),
    /missing direct dependency/,
  );
});

test("requires manually staged Windows binaries to match the frozen lock integrity", () => {
  const tarball = Buffer.from("locked archive");
  const integrity = createHash("sha512").update(tarball).digest("base64");
  const lockText = [
    '"@img/sharp-win32-x64@0.34.5":',
    '  version "0.34.5"',
    `  integrity sha512-${integrity}`,
    "",
  ].join("\n");
  assert.equal(validateLockedPackageTarball({
    lockText,
    packageName: "@img/sharp-win32-x64",
    tarball,
    version: "0.34.5",
  }), "@img/sharp-win32-x64@0.34.5");
  assert.throws(
    () => validateLockedPackageTarball({
      lockText,
      packageName: "@img/sharp-win32-x64",
      tarball: Buffer.from("different archive"),
      version: "0.34.5",
    }),
    /does not match yarn.lock/,
  );
  assert.throws(
    () => validateLockedPackageTarball({
      lockText,
      packageName: "@img/sharp-win32-x64",
      tarball,
      version: "0.34.6",
    }),
    /Expected one exact/,
  );
});

test("tracks direct runtime imports of Backend deployment scripts", () => {
  for (const path of backendDeploymentPaths.filter(
    (candidate) => candidate.startsWith("scripts/") && candidate.endsWith(".mjs")
  )) {
    const sourcePath = resolve(root, path);
    const source = readFileSync(sourcePath, "utf8");
    const imports = source.matchAll(
      /(?:from\s+|import\s*\(\s*|import\s+)["']\.\/([^"']+\.mjs)["']/g
    );
    for (const match of imports) {
      const dependency = relative(
        root,
        resolve(dirname(sourcePath), match[1])
      ).split(sep).join("/");
      assert.ok(
        backendDeploymentPaths.includes(dependency),
        `${path} imports untracked Backend runtime dependency ${dependency}`
      );
    }
  }
});

test("requeues only the current repository's main Backend workflow", () => {
  assert.deepEqual(createBackendRequeueCommand({
    hasToken: true,
    repository: "owner/repository",
  }), [
    "workflow",
    "run",
    "deploy-backend.yml",
    "--repo",
    "owner/repository",
    "--ref",
    "main",
  ]);
  assert.throws(
    () => createBackendRequeueCommand({
      hasToken: true,
      repository: "../other",
    }),
    /GITHUB_REPOSITORY/,
  );
  assert.throws(
    () => createBackendRequeueCommand({
      hasToken: false,
      repository: "owner/repository",
    }),
    /GH_TOKEN/,
  );
});

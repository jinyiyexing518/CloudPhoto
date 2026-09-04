#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = dirname(dirname(scriptPath));

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function directoryEntries(path, allowMissing = false) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return [];
    throw error;
  }
}

async function collectPackageDirectory(path, packages) {
  let manifest;
  try {
    manifest = await readJson(join(path, "package.json"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (typeof manifest?.name !== "string" || typeof manifest?.version !== "string") {
    throw new Error(`Installed package at ${path} has no canonical name/version`);
  }
  packages.add(`${manifest.name}@${manifest.version}`);
  await collectNodeModules(join(path, "node_modules"), packages, true);
}

async function collectNodeModules(path, packages, allowMissing = false) {
  for (const entry of await directoryEntries(path, allowMissing)) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    const entryPath = join(path, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scopedEntry of await directoryEntries(entryPath)) {
        if (scopedEntry.isDirectory()) {
          await collectPackageDirectory(join(entryPath, scopedEntry.name), packages);
        }
      }
    } else {
      await collectPackageDirectory(entryPath, packages);
    }
  }
}

export function validateBackendPackageGraph({
  dependencies,
  stagedPackages,
  testedPackages,
}) {
  const stagedNames = new Set(
    [...stagedPackages].map((packageId) => packageId.slice(0, packageId.lastIndexOf("@")))
  );
  for (const dependency of Object.keys(dependencies).sort()) {
    if (!stagedNames.has(dependency)) {
      throw new Error(`Staged backend package is missing direct dependency ${dependency}`);
    }
  }
  for (const packageId of [...stagedPackages].sort()) {
    if (!testedPackages.has(packageId)) {
      throw new Error(
        `Staged backend dependency ${packageId} is absent from the frozen tested graph`
      );
    }
  }
  return [...stagedPackages].sort();
}

export function validateLockedPackageTarball({
  lockText,
  packageName,
  tarball,
  version,
}) {
  const selector = JSON.stringify(`${packageName}@${version}`);
  const lines = lockText.split(/\r?\n/);
  const headers = lines
    .map((line, index) => line === `${selector}:` ? index : -1)
    .filter((index) => index >= 0);
  if (headers.length !== 1) {
    throw new Error(`Expected one exact ${selector} entry in yarn.lock`);
  }
  const block = [];
  for (let index = headers[0] + 1; index < lines.length; index += 1) {
    if (lines[index] && !/^\s/.test(lines[index])) break;
    block.push(lines[index]);
  }
  const lockedVersions = block
    .map((line) => line.match(/^  version "([^"]+)"$/)?.[1])
    .filter(Boolean);
  const integrities = block
    .map((line) => line.match(/^  integrity (sha512-[A-Za-z0-9+/=]+)$/)?.[1])
    .filter(Boolean);
  if (
    lockedVersions.length !== 1
    || lockedVersions[0] !== version
    || integrities.length !== 1
  ) {
    throw new Error(`Incomplete or mismatched lock metadata for ${packageName}@${version}`);
  }
  const expected = Buffer.from(integrities[0].slice("sha512-".length), "base64");
  const actual = createHash("sha512").update(tarball).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error(`Downloaded ${packageName}@${version} tarball does not match yarn.lock`);
  }
  return `${packageName}@${version}`;
}

async function verifyWindowsSharpTarball(path, version) {
  const verified = validateLockedPackageTarball({
    lockText: await readFile(join(root, "yarn.lock"), "utf8"),
    packageName: "@img/sharp-win32-x64",
    tarball: await readFile(resolve(root, path)),
    version,
  });
  console.log(`Backend Windows binary contract passed: ${verified}`);
}

async function verifyBackendPackageGraph() {
  const serverManifest = await readJson(join(root, "packages", "server", "package.json"));
  const testedPackages = new Set();
  await collectNodeModules(join(root, "node_modules"), testedPackages);
  await collectNodeModules(
    join(root, "packages", "server", "node_modules"),
    testedPackages,
    true
  );
  const stagedPackages = new Set();
  await collectNodeModules(join(root, "deploy-stage", "node_modules"), stagedPackages);
  const verified = validateBackendPackageGraph({
    dependencies: serverManifest.dependencies ?? {},
    stagedPackages,
    testedPackages,
  });
  console.log(
    `Backend package dependency contract passed: ${verified.length} locked package version(s)`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await verifyBackendPackageGraph();
  } else if (args.length === 3 && args[0] === "--verify-windows-sharp") {
    await verifyWindowsSharpTarball(args[1], args[2]);
  } else {
    throw new Error(
      "Usage: check-backend-package-dependencies.mjs [--verify-windows-sharp <tarball> <version>]"
    );
  }
}

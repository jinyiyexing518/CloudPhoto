#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = dirname(dirname(scriptPath));
const MANIFEST_NAME = "deployment-assets.json";
const MANIFEST_VERSION = 1;
const HASHED_CODE_PATTERN = /^assets\/.+-[A-Za-z0-9_-]{8,}\.(?:css|js)$/;

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function portablePath(path) {
  return path.split(sep).join("/");
}

function assertGenerationId(id) {
  if (
    typeof id !== "string"
    || id.length < 7
    || id.length > 128
    || !/^[A-Za-z0-9._-]+$/.test(id)
  ) {
    throw new Error(`Invalid deployment generation id: ${JSON.stringify(id)}`);
  }
}

function assertAsset(asset) {
  if (
    !asset
    || typeof asset.path !== "string"
    || !HASHED_CODE_PATTERN.test(asset.path)
    || asset.path.includes("..")
  ) {
    throw new Error(`Invalid retained asset path: ${JSON.stringify(asset?.path)}`);
  }
  if (
    !Number.isSafeInteger(asset.bytes)
    || asset.bytes < 0
    || typeof asset.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(asset.sha256)
  ) {
    throw new Error(`Invalid retained asset metadata: ${asset.path}`);
  }
}

function assertConfig(config) {
  if (
    !Number.isSafeInteger(config?.maxGenerations)
    || config.maxGenerations < 1
    || config.maxGenerations > 100
  ) {
    throw new Error("Deployment retention maxGenerations must be between 1 and 100");
  }
  if (
    !Number.isSafeInteger(config?.maxBytes)
    || config.maxBytes < 1
    || config.maxBytes > 256 * 1024 * 1024
  ) {
    throw new Error("Deployment retention maxBytes must be between 1 and 256 MiB");
  }
  if (!Array.isArray(config.revokedGenerationIds)) {
    throw new Error("Deployment retention revokedGenerationIds must be an array");
  }
  for (const id of config.revokedGenerationIds) assertGenerationId(id);
}

export function validateDeploymentManifest(manifest) {
  if (manifest?.version !== MANIFEST_VERSION || !Array.isArray(manifest.generations)) {
    throw new Error("Invalid deployment asset manifest");
  }
  const generationIds = new Set();
  const paths = new Map();
  for (const generation of manifest.generations) {
    assertGenerationId(generation?.id);
    if (generationIds.has(generation.id)) {
      throw new Error(`Duplicate deployment generation: ${generation.id}`);
    }
    generationIds.add(generation.id);
    if (!Array.isArray(generation.assets) || generation.assets.length === 0) {
      throw new Error(`Deployment generation has no assets: ${generation.id}`);
    }
    for (const asset of generation.assets) {
      assertAsset(asset);
      const known = paths.get(asset.path);
      if (
        known
        && (known.sha256 !== asset.sha256 || known.bytes !== asset.bytes)
      ) {
        throw new Error(`Retained asset path collision: ${asset.path}`);
      }
      paths.set(asset.path, asset);
    }
  }
  return manifest;
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function assetsFromDist(distDir) {
  const assetsDir = join(distDir, "assets");
  const files = await listFiles(assetsDir);
  const sourceMaps = files.filter((path) => path.endsWith(".map"));
  if (sourceMaps.length > 0) {
    throw new Error(
      `Deployment retention refuses source maps: ${sourceMaps.map((path) => basename(path)).join(", ")}`,
    );
  }
  const assets = [];
  for (const path of files) {
    const assetPath = portablePath(relative(distDir, path));
    if (!/\.(?:css|js)$/.test(assetPath)) continue;
    if (!HASHED_CODE_PATTERN.test(assetPath)) {
      throw new Error(`Deployment code asset is not content-hashed: ${assetPath}`);
    }
    const content = await readFile(path);
    assets.push({
      path: assetPath,
      bytes: content.byteLength,
      sha256: digest(content),
    });
  }
  assets.sort((left, right) => left.path.localeCompare(right.path));
  if (assets.length === 0) {
    throw new Error("Deployment contains no hashed JavaScript or CSS assets");
  }
  return assets;
}

export async function manifestFromDist({ distDir, generationId }) {
  assertGenerationId(generationId);
  const assets = await assetsFromDist(distDir);
  return {
    version: MANIFEST_VERSION,
    generations: [{ id: generationId, assets }],
    totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
  };
}

export function selectBootstrapManifest(builtManifest, ref, requiredAssetPaths) {
  validateDeploymentManifest(builtManifest);
  if (!Array.isArray(requiredAssetPaths) || requiredAssetPaths.length === 0) {
    throw new Error(`Bootstrap generation ${ref} must declare exact required assets`);
  }
  const uniquePaths = new Set(requiredAssetPaths);
  if (uniquePaths.size !== requiredAssetPaths.length) {
    throw new Error(`Bootstrap generation ${ref} contains duplicate required assets`);
  }
  const builtGeneration = builtManifest.generations[0];
  const builtAssets = new Map(
    builtGeneration.assets.map((asset) => [asset.path, asset]),
  );
  const assets = requiredAssetPaths.map((path) => {
    assertAsset({ path, bytes: 0, sha256: "0".repeat(64) });
    const asset = builtAssets.get(path);
    if (!asset) {
      throw new Error(`Bootstrap generation ${ref} did not produce required asset: ${path}`);
    }
    return asset;
  });
  return {
    version: MANIFEST_VERSION,
    generations: [{ id: builtGeneration.id, assets }],
    totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
  };
}

function selectGenerations(current, previous, config) {
  const revoked = new Set(config.revokedGenerationIds);
  if (revoked.has(current.id)) {
    throw new Error(`Current deployment generation is revoked: ${current.id}`);
  }
  const candidates = [
    current,
    ...previous.generations.filter((generation) => (
      generation.id !== current.id && !revoked.has(generation.id)
    )),
  ].slice(0, config.maxGenerations);
  const selected = [];
  const assets = new Map();
  let totalBytes = 0;

  for (const generation of candidates) {
    let addedBytes = 0;
    for (const asset of generation.assets) {
      const known = assets.get(asset.path);
      if (
        known
        && (known.sha256 !== asset.sha256 || known.bytes !== asset.bytes)
      ) {
        throw new Error(`Retained asset path collision: ${asset.path}`);
      }
      if (!known) addedBytes += asset.bytes;
    }
    if (totalBytes + addedBytes > config.maxBytes) {
      if (selected.length === 0) {
        throw new Error(
          `Current deployment assets exceed the ${config.maxBytes}-byte retention budget`,
        );
      }
      break;
    }
    selected.push(generation);
    for (const asset of generation.assets) assets.set(asset.path, asset);
    totalBytes += addedBytes;
  }

  return { assets, generations: selected, totalBytes };
}

async function removeUnselectedCodeAssets(distDir, selectedPaths) {
  const files = await listFiles(join(distDir, "assets"));
  for (const path of files) {
    const assetPath = portablePath(relative(distDir, path));
    if (
      /\.(?:css|js|map)$/.test(assetPath)
      && !selectedPaths.has(assetPath)
    ) {
      await unlink(path);
    }
  }
}

export async function mergeDeploymentAssets({
  distDir,
  generationId,
  previousManifest = { version: MANIFEST_VERSION, generations: [] },
  fetchAsset,
  config,
}) {
  assertConfig(config);
  assertGenerationId(generationId);
  if (typeof fetchAsset !== "function") {
    throw new Error("Deployment retention requires an asset fetcher");
  }
  validateDeploymentManifest({
    version: MANIFEST_VERSION,
    generations: previousManifest.generations ?? [],
  });
  const current = {
    id: generationId,
    assets: await assetsFromDist(distDir),
  };
  const selected = selectGenerations(current, previousManifest, config);

  for (const generation of selected.generations.slice(1)) {
    for (const asset of generation.assets) {
      const destination = join(distDir, ...asset.path.split("/"));
      let existing;
      try {
        existing = await readFile(destination);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const content = existing ?? await fetchAsset(asset, generation);
      if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
        throw new Error(`Retained asset fetch returned no bytes: ${asset.path}`);
      }
      const bytes = Buffer.from(content);
      if (bytes.byteLength !== asset.bytes || digest(bytes) !== asset.sha256) {
        throw new Error(`Retained asset integrity check failed: ${asset.path}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
  }

  await removeUnselectedCodeAssets(distDir, new Set(selected.assets.keys()));
  const manifest = {
    version: MANIFEST_VERSION,
    generations: selected.generations,
    totalBytes: selected.totalBytes,
  };
  await writeFile(
    join(distDir, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

function run(command, args, cwd, env = process.env) {
  const executable = process.platform === "win32" && command === "yarn"
    ? "yarn.cmd"
    : command;
  const result = spawnSync(executable, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
}

async function buildBootstrapGeneration(ref, requiredAssetPaths) {
  assertGenerationId(ref);
  const worktree = await mkdtemp(join(tmpdir(), "cloudphoto-bootstrap-"));
  await rm(worktree, { recursive: true, force: true });
  try {
    run("git", ["worktree", "add", "--detach", worktree, ref], root);
    run("yarn", ["install", "--frozen-lockfile"], worktree);
    run("yarn", ["workspace", "cloudphoto-client", "build"], worktree);
    const id = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree,
      encoding: "utf8",
      shell: process.platform === "win32",
    }).stdout.trim();
    const builtManifest = await manifestFromDist({
      distDir: join(worktree, "packages", "client", "dist"),
      generationId: id,
    });
    return {
      manifest: selectBootstrapManifest(builtManifest, ref, requiredAssetPaths),
      worktree,
    };
  } catch (error) {
    await removeBootstrapWorktree(worktree, true);
    throw error;
  }
}

async function removeBootstrapWorktree(worktree, preserveOriginalError = false) {
  if (!await stat(worktree).catch(() => null)) return;
  try {
    run("git", ["worktree", "remove", "--force", worktree], root);
  } catch (cleanupError) {
    await rm(worktree, { recursive: true, force: true });
    if (!preserveOriginalError) throw cleanupError;
    console.error(
      `Bootstrap cleanup failed for ${worktree}; preserving the original error:`,
      cleanupError,
    );
  }
}

async function loadPreviousDeployment(source, bootstrapRefs, bootstrapGenerationAssets) {
  const manifestUrl = new URL(`/${MANIFEST_NAME}?retention=${Date.now()}`, source);
  const response = await fetch(manifestUrl, {
    cache: "no-store",
    headers: { "User-Agent": "cloudphoto-deployment-retention/1.0" },
  });
  if (response.status === 200) {
    const manifest = validateDeploymentManifest(await response.json());
    return {
      fetchAsset: async (asset) => {
        const assetResponse = await fetch(new URL(`/${asset.path}`, source), {
          cache: "no-store",
          headers: { "User-Agent": "cloudphoto-deployment-retention/1.0" },
        });
        if (assetResponse.status !== 200) {
          throw new Error(
            `Retained asset fetch failed (${assetResponse.status}): ${asset.path}`,
          );
        }
        return Buffer.from(await assetResponse.arrayBuffer());
      },
      manifest,
      cleanup: async () => {},
      source: "live-manifest",
    };
  }
  if (response.status !== 404) {
    throw new Error(
      `Previous deployment manifest returned ${response.status}; refusing to shrink the compatibility window`,
    );
  }

  const builds = [];
  try {
    for (const ref of bootstrapRefs) {
      builds.push(await buildBootstrapGeneration(ref, bootstrapGenerationAssets[ref]));
    }
    const generations = builds.flatMap(({ manifest }) => manifest.generations);
    return {
      fetchAsset: async (asset, generation) => {
        const build = builds.find(
          ({ manifest }) => manifest.generations[0].id === generation.id,
        );
        if (!build) throw new Error(`Missing bootstrap generation: ${generation.id}`);
        return readFile(join(
          build.worktree,
          "packages",
          "client",
          "dist",
          ...asset.path.split("/"),
        ));
      },
      manifest: validateDeploymentManifest({
        version: MANIFEST_VERSION,
        generations,
      }),
      cleanup: async () => {
        for (const build of builds) {
          await removeBootstrapWorktree(build.worktree);
        }
      },
      source: "bootstrap-build",
    };
  } catch (error) {
    for (const build of builds) {
      await removeBootstrapWorktree(build.worktree, true);
    }
    throw error;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value, received ${argv.slice(index).join(" ")}`);
    }
    options[name.slice(2)] = value;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const distDir = resolve(root, options.dist ?? "packages/client/dist");
  const generationId = options.generation ?? process.env.GITHUB_SHA;
  const source = options.source;
  const policyPath = resolve(
    root,
    options.policy ?? "packages/client/deployment-retention.json",
  );
  if (!generationId || !source) {
    throw new Error("Usage: deployment-assets.mjs --generation <id> --source <origin>");
  }
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  assertConfig(policy);
  if (!Array.isArray(policy.bootstrapGenerationRefs)) {
    throw new Error("Deployment retention bootstrapGenerationRefs must be an array");
  }
  if (
    !policy.bootstrapGenerationAssets
    || typeof policy.bootstrapGenerationAssets !== "object"
    || Array.isArray(policy.bootstrapGenerationAssets)
  ) {
    throw new Error("Deployment retention bootstrapGenerationAssets must be an object");
  }
  const previous = await loadPreviousDeployment(
    source,
    policy.bootstrapGenerationRefs,
    policy.bootstrapGenerationAssets,
  );
  try {
    const manifest = await mergeDeploymentAssets({
      distDir,
      generationId,
      previousManifest: previous.manifest,
      fetchAsset: previous.fetchAsset,
      config: policy,
    });
    console.log(
      `Deployment assets ready: source=${previous.source} generations=${manifest.generations.length}/${policy.maxGenerations} bytes=${manifest.totalBytes}/${policy.maxBytes}`,
    );
  } finally {
    await previous.cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

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
  symlink,
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
const JAVASCRIPT_MEDIA_TYPES = new Set(["application/javascript", "text/javascript"]);

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
  if (config.bootstrapSourceManifest !== undefined && (
    config.bootstrapSourceManifest.status !== 200
    || config.bootstrapSourceManifest.contentType !== "text/html"
    || config.bootstrapSourceManifest.captureHashedAssets !== true
    || !Number.isSafeInteger(config.bootstrapSourceManifest.maxAssets)
    || config.bootstrapSourceManifest.maxAssets < 1
    || config.bootstrapSourceManifest.maxAssets > 2048
    || typeof config.bootstrapSourceManifest.normalizedSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(config.bootstrapSourceManifest.normalizedSha256)
    || typeof config.bootstrapSourceManifest.expiresAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(
      config.bootstrapSourceManifest.expiresAt,
    )
    || !Number.isFinite(Date.parse(config.bootstrapSourceManifest.expiresAt))
  )) {
    throw new Error("Deployment retention bootstrap source manifest pin is invalid");
  }
}

export function validateDeploymentManifest(manifest, { allowEmpty = false } = {}) {
  if (
    manifest?.version !== MANIFEST_VERSION
    || !Array.isArray(manifest.generations)
    || (!allowEmpty && manifest.generations.length === 0)
  ) {
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
  requiredPreviousGenerationIds = [],
}) {
  assertConfig(config);
  assertGenerationId(generationId);
  if (typeof fetchAsset !== "function") {
    throw new Error("Deployment retention requires an asset fetcher");
  }
  validateDeploymentManifest(
    {
      version: MANIFEST_VERSION,
      generations: previousManifest.generations ?? [],
    },
    { allowEmpty: true },
  );
  const current = {
    id: generationId,
    assets: await assetsFromDist(distDir),
  };
  const selected = selectGenerations(current, previousManifest, config);
  for (const id of requiredPreviousGenerationIds) {
    assertGenerationId(id);
    if (!selected.generations.some((generation) => generation.id === id)) {
      throw new Error(`Required bootstrap generation does not fit the retention policy: ${id}`);
    }
  }

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
    const installedDependencies = join(root, "node_modules");
    if (!(await stat(installedDependencies).catch(() => null))?.isDirectory()) {
      throw new Error("Bootstrap generation requires the workflow-installed node_modules");
    }
    await symlink(
      installedDependencies,
      join(worktree, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    run(
      "yarn",
      ["--cwd", join(worktree, "packages", "client"), "vite", "build"],
      worktree,
    );
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
    await unlink(join(worktree, "node_modules")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
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

function mediaType(value) {
  return value?.split(";", 1)[0].trim().toLowerCase() ?? "";
}

function referencedHashedCodePaths(content, baseUrl) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`Bootstrap asset is not valid UTF-8: ${baseUrl.pathname}`);
  }
  const references = new Set();
  const pattern = /(?:^|["'`(\s=,:])((?:\/assets\/|\.\/|assets\/)[A-Za-z0-9_./-]+-[A-Za-z0-9_-]{8,}\.(?:css|js))/g;
  for (const match of text.matchAll(pattern)) {
    const candidate = match[1];
    const url = candidate.startsWith("assets/")
      ? new URL(`/${candidate}`, baseUrl)
      : new URL(candidate, baseUrl);
    const path = url.pathname.slice(1);
    if (url.origin === baseUrl.origin && HASHED_CODE_PATTERN.test(path)) {
      references.add(path);
    }
  }
  return [...references].sort();
}

export async function captureLiveBootstrapGeneration({
  source,
  htmlBody,
  maxAssets,
  maxBytes,
  fetchImpl = fetch,
}) {
  if (!Number.isSafeInteger(maxAssets) || maxAssets < 1 || maxAssets > 2048) {
    throw new Error("Bootstrap live generation asset limit is invalid");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Bootstrap live generation byte limit is invalid");
  }
  const sourceUrl = new URL("/", source);
  const discovered = new Set();
  const pending = [];
  const contents = new Map();
  let totalBytes = 0;

  const discover = (content, baseUrl) => {
    for (const path of referencedHashedCodePaths(content, baseUrl)) {
      if (discovered.has(path)) continue;
      discovered.add(path);
      pending.push(path);
    }
    pending.sort();
    if (discovered.size > maxAssets) {
      throw new Error(`Bootstrap live generation exceeds the ${maxAssets}-asset limit`);
    }
  };

  discover(htmlBody, sourceUrl);
  if (pending.length === 0) {
    throw new Error("Bootstrap HTML contains no hashed JavaScript or CSS assets");
  }

  while (pending.length > 0) {
    const path = pending.shift();
    const assetUrl = new URL(`/${path}`, sourceUrl);
    const response = await fetchImpl(assetUrl, {
      cache: "no-store",
      headers: { "User-Agent": "cloudphoto-deployment-retention/1.0" },
    });
    const type = mediaType(response.headers.get("content-type"));
    const expectedType = path.endsWith(".css")
      ? type === "text/css"
      : JAVASCRIPT_MEDIA_TYPES.has(type);
    if (response.status !== 200 || !expectedType) {
      throw new Error(
        `Bootstrap live asset fetch failed (${response.status} ${type || "unknown content type"}): ${path}`,
      );
    }
    const content = Buffer.from(await response.arrayBuffer());
    if (content.byteLength === 0) {
      throw new Error(`Bootstrap live asset is empty: ${path}`);
    }
    totalBytes += content.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`Bootstrap live generation exceeds the ${maxBytes}-byte retention budget`);
    }
    contents.set(path, content);
    discover(content, assetUrl);
  }

  const assets = [...contents.entries()]
    .map(([path, content]) => ({
      path,
      bytes: content.byteLength,
      sha256: digest(content),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const generationId = `bootstrap-live-${digest(htmlBody).slice(0, 24)}`;
  const manifest = validateDeploymentManifest({
    version: MANIFEST_VERSION,
    generations: [{ id: generationId, assets }],
    totalBytes,
  });
  return {
    fetchAsset: async (asset) => {
      const content = contents.get(asset.path);
      if (!content) throw new Error(`Missing captured bootstrap asset: ${asset.path}`);
      return content;
    },
    manifest,
  };
}

export function normalizedBootstrapHtmlDigest(body) {
  let html;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  const entryJs = /\/assets\/index-[A-Za-z0-9_-]{8,}\.js/g;
  const entryCss = /\/assets\/index-[A-Za-z0-9_-]{8,}\.css/g;
  if ([...html.matchAll(entryJs)].length !== 1 || [...html.matchAll(entryCss)].length !== 1) {
    return null;
  }
  const normalized = html
    .replace(entryJs, "/assets/index-<hash>.js")
    .replace(entryCss, "/assets/index-<hash>.css");
  return digest(Buffer.from(normalized, "utf8"));
}

export function matchesBootstrapSourceResponse(
  { status, contentType, body },
  expected,
  now = Date.now(),
) {
  if (!expected) return false;
  return (
    status === expected.status
    && mediaType(contentType) === expected.contentType
    && now < Date.parse(expected.expiresAt)
    && normalizedBootstrapHtmlDigest(body) === expected.normalizedSha256
  );
}

async function loadPreviousDeployment(
  source,
  bootstrapRefs,
  bootstrapGenerationAssets,
  bootstrapSourceManifest,
  maxBytes,
) {
  const manifestUrl = new URL(`/${MANIFEST_NAME}?retention=${Date.now()}`, source);
  const response = await fetch(manifestUrl, {
    cache: "no-store",
    headers: { "User-Agent": "cloudphoto-deployment-retention/1.0" },
  });
  const body = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type");
  if (response.status === 200 && mediaType(contentType) === "application/json") {
    const manifest = validateDeploymentManifest(JSON.parse(body.toString("utf8")));
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
      requiredGenerationIds: [],
      source: "live-manifest",
    };
  }
  if (!matchesBootstrapSourceResponse(
    {
      status: response.status,
      contentType,
      body,
    },
    bootstrapSourceManifest,
  )) {
    throw new Error(
      `Previous deployment manifest returned unpinned ${response.status} ${
        mediaType(contentType) || "unknown content type"
      }; refusing to shrink the compatibility window`,
    );
  }

  const live = await captureLiveBootstrapGeneration({
    source,
    htmlBody: body,
    maxAssets: bootstrapSourceManifest.maxAssets,
    maxBytes,
  });
  const builds = [];
  try {
    for (const ref of bootstrapRefs) {
      builds.push(await buildBootstrapGeneration(ref, bootstrapGenerationAssets[ref]));
    }
    const generations = [
      ...live.manifest.generations,
      ...builds.flatMap(({ manifest }) => manifest.generations),
    ];
    return {
      fetchAsset: async (asset, generation) => {
        if (generation.id === live.manifest.generations[0].id) {
          return live.fetchAsset(asset);
        }
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
      requiredGenerationIds: generations.map(({ id }) => id),
      source: "bootstrap-live-and-build",
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
  if (!policy.bootstrapSourceManifest) {
    throw new Error("Deployment retention bootstrapSourceManifest must pin the migration source");
  }
  const previous = await loadPreviousDeployment(
    source,
    policy.bootstrapGenerationRefs,
    policy.bootstrapGenerationAssets,
    policy.bootstrapSourceManifest,
    policy.maxBytes,
  );
  try {
    const manifest = await mergeDeploymentAssets({
      distDir,
      generationId,
      previousManifest: previous.manifest,
      fetchAsset: previous.fetchAsset,
      config: policy,
      requiredPreviousGenerationIds: previous.requiredGenerationIds,
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

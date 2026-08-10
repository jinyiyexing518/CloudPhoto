import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cloudphoto-retention-"));
  const currentDist = join(root, "current");
  const previousDist = join(root, "previous");
  await mkdir(join(currentDist, "assets"), { recursive: true });
  await mkdir(join(previousDist, "assets"), { recursive: true });
  return {
    currentDist,
    previousDist,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function writeAsset(distDir, path, content) {
  const fullPath = join(distDir, ...path.split("/"));
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content);
  return {
    path,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
  };
}

test("retains old hashed JS/CSS with a bounded, integrity-checked manifest", async () => {
  const files = await fixture();
  try {
    const currentJs = await writeAsset(
      files.currentDist,
      "assets/AuthenticatedApp-current123.js",
      "export default 'current';",
    );
    const currentCss = await writeAsset(
      files.currentDist,
      "assets/AuthenticatedApp-current123.css",
      "body{color:green}",
    );
    const oldJs = await writeAsset(
      files.previousDist,
      "assets/AuthenticatedApp-previous1.js",
      "export default 'previous';",
    );
    const oldCss = await writeAsset(
      files.previousDist,
      "assets/AuthenticatedApp-previous1.css",
      "body{color:blue}",
    );
    const { mergeDeploymentAssets } = await import("./deployment-assets.mjs");

    const manifest = await mergeDeploymentAssets({
      distDir: files.currentDist,
      generationId: "current-generation",
      previousManifest: {
        version: 1,
        generations: [{
          id: "previous-generation",
          assets: [oldJs, oldCss],
        }],
      },
      fetchAsset: async (asset) => readFile(join(files.previousDist, ...asset.path.split("/"))),
      config: {
        maxGenerations: 2,
        maxBytes: 1024,
        revokedGenerationIds: [],
      },
    });

    assert.deepEqual(
      manifest.generations.map(({ id }) => id),
      ["current-generation", "previous-generation"],
    );
    assert.deepEqual(
      manifest.generations[0].assets.map(({ path }) => path).sort(),
      [currentCss.path, currentJs.path].sort(),
    );
    assert.equal(
      await readFile(join(files.currentDist, ...oldJs.path.split("/")), "utf8"),
      "export default 'previous';",
    );
    assert.equal(
      await readFile(join(files.currentDist, ...oldCss.path.split("/")), "utf8"),
      "body{color:blue}",
    );
    const serialized = JSON.stringify(manifest);
    assert.doesNotMatch(serialized, /https?:|token|workspace/i);
  } finally {
    await files.dispose();
  }
});

test("evicts complete oldest generations until both generation and unique-byte limits hold", async () => {
  const files = await fixture();
  try {
    const current = await writeAsset(
      files.currentDist,
      "assets/index-current12.js",
      "c".repeat(20),
    );
    const middle = {
      path: "assets/index-middle123.js",
      bytes: 20,
      sha256: sha256("m".repeat(20)),
    };
    const oldest = {
      path: "assets/index-oldest123.js",
      bytes: 20,
      sha256: sha256("o".repeat(20)),
    };
    const bodies = new Map([
      [middle.path, Buffer.from("m".repeat(20))],
      [oldest.path, Buffer.from("o".repeat(20))],
    ]);
    const { mergeDeploymentAssets } = await import("./deployment-assets.mjs");

    const manifest = await mergeDeploymentAssets({
      distDir: files.currentDist,
      generationId: "current",
      previousManifest: {
        version: 1,
        generations: [
          { id: "middle1", assets: [middle] },
          { id: "oldest1", assets: [oldest] },
        ],
      },
      fetchAsset: async (asset) => bodies.get(asset.path),
      config: {
        maxGenerations: 3,
        maxBytes: current.bytes + middle.bytes,
        revokedGenerationIds: [],
      },
    });

    assert.deepEqual(manifest.generations.map(({ id }) => id), ["current", "middle1"]);
    assert.equal(manifest.totalBytes, 40);
    await assert.rejects(
      readFile(join(files.currentDist, ...oldest.path.split("/"))),
      { code: "ENOENT" },
    );
  } finally {
    await files.dispose();
  }
});

test("revocation, source-map rejection, and digest validation fail closed", async () => {
  const files = await fixture();
  try {
    await writeAsset(files.currentDist, "assets/index-current12.js", "current");
    const revoked = {
      path: "assets/index-revoked12.js",
      bytes: 7,
      sha256: sha256("revoked"),
    };
    const { mergeDeploymentAssets } = await import("./deployment-assets.mjs");

    const manifest = await mergeDeploymentAssets({
      distDir: files.currentDist,
      generationId: "current",
      previousManifest: {
        version: 1,
        generations: [{ id: "known-vulnerable", assets: [revoked] }],
      },
      fetchAsset: async () => Buffer.from("revoked"),
      config: {
        maxGenerations: 24,
        maxBytes: 64 * 1024 * 1024,
        revokedGenerationIds: ["known-vulnerable"],
      },
    });
    assert.deepEqual(manifest.generations.map(({ id }) => id), ["current"]);

    await assert.rejects(
      mergeDeploymentAssets({
        distDir: files.currentDist,
        generationId: "current",
        previousManifest: { version: 1, generations: [] },
        fetchAsset: async () => Buffer.alloc(0),
        config: {
          maxGenerations: 24,
          maxBytes: 64 * 1024 * 1024,
          revokedGenerationIds: ["current"],
        },
      }),
      /current deployment generation is revoked/i,
    );

    await writeAsset(files.currentDist, "assets/index-current12.js.map", "{}");
    await assert.rejects(
      mergeDeploymentAssets({
        distDir: files.currentDist,
        generationId: "current",
        previousManifest: { version: 1, generations: [] },
        fetchAsset: async () => Buffer.alloc(0),
        config: {
          maxGenerations: 24,
          maxBytes: 64 * 1024 * 1024,
          revokedGenerationIds: [],
        },
      }),
      /source map/i,
    );
    await rm(join(files.currentDist, "assets", "index-current12.js.map"));

    await assert.rejects(
      mergeDeploymentAssets({
        distDir: files.currentDist,
        generationId: "current",
        previousManifest: {
          version: 1,
          generations: [{ id: "tampered", assets: [revoked] }],
        },
        fetchAsset: async () => Buffer.from("changed"),
        config: {
          maxGenerations: 24,
          maxBytes: 64 * 1024 * 1024,
          revokedGenerationIds: [],
        },
      }),
      /integrity/i,
    );
  } finally {
    await files.dispose();
  }
});

test("repository retention policy is finite and includes the stranded pre-recovery generation", async () => {
  const policy = JSON.parse(await readFile(
    new URL("../packages/client/deployment-retention.json", import.meta.url),
    "utf8",
  ));
  assert.equal(policy.maxGenerations, 24);
  assert.equal(policy.maxBytes, 64 * 1024 * 1024);
  assert.deepEqual(policy.bootstrapGenerationRefs, [
    "ebd80d1b2bbe0ffca11f9c1fe56dfe1279657ef2",
  ]);
  assert.deepEqual(policy.bootstrapGenerationAssets, {
    ebd80d1b2bbe0ffca11f9c1fe56dfe1279657ef2: [
      "assets/AuthenticatedApp-BkGhvsE_.css",
    ],
  });
  assert.ok(Array.isArray(policy.revokedGenerationIds));
});

test("bootstrap migration publishes only exact policy assets from a reproducible build", async () => {
  const { selectBootstrapManifest } = await import("./deployment-assets.mjs");
  const css = {
    path: "assets/AuthenticatedApp-BkGhvsE_.css",
    bytes: 4,
    sha256: sha256("body"),
  };
  const nondeterministicJs = {
    path: "assets/AuthenticatedApp-buildtime1.js",
    bytes: 6,
    sha256: sha256("export"),
  };
  const builtManifest = {
    version: 1,
    generations: [{
      id: "ebd80d1b2bbe0ffca11f9c1fe56dfe1279657ef2",
      assets: [css, nondeterministicJs],
    }],
  };

  const selected = selectBootstrapManifest(
    builtManifest,
    "ebd80d1b2bbe0ffca11f9c1fe56dfe1279657ef2",
    [css.path],
  );
  assert.deepEqual(selected.generations[0].assets, [css]);
  assert.equal(selected.totalBytes, css.bytes);
  await assert.rejects(
    async () => selectBootstrapManifest(
      builtManifest,
      "ebd80d1b2bbe0ffca11f9c1fe56dfe1279657ef2",
      ["assets/AuthenticatedApp-original1.js"],
    ),
    /did not produce required asset/i,
  );
});

test("a workflow rerun keeps the prior exact artifacts as a separate generation", async () => {
  const files = await fixture();
  try {
    await writeAsset(files.currentDist, "assets/index-rerun002.js", "new timestamp");
    const prior = {
      path: "assets/index-rerun001.js",
      bytes: Buffer.byteLength("old timestamp"),
      sha256: sha256("old timestamp"),
    };
    const { mergeDeploymentAssets } = await import("./deployment-assets.mjs");
    const manifest = await mergeDeploymentAssets({
      distDir: files.currentDist,
      generationId: "samecommit-run2-attempt1",
      previousManifest: {
        version: 1,
        generations: [{
          id: "samecommit-run1-attempt1",
          assets: [prior],
        }],
      },
      fetchAsset: async () => Buffer.from("old timestamp"),
      config: {
        maxGenerations: 24,
        maxBytes: 64 * 1024 * 1024,
        revokedGenerationIds: [],
      },
    });

    assert.deepEqual(
      manifest.generations.map(({ id }) => id),
      ["samecommit-run2-attempt1", "samecommit-run1-attempt1"],
    );
    assert.equal(
      await readFile(join(files.currentDist, ...prior.path.split("/")), "utf8"),
      "old timestamp",
    );
  } finally {
    await files.dispose();
  }
});

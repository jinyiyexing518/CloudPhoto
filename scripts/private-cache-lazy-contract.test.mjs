#!/usr/bin/env node

import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const distPath = new URL("packages/client/dist/", root);

test("private Workbox cleanup stays behind an awaited dynamic boundary", async () => {
  const [lifecycle, cleanup, auth, http] = await Promise.all([
    source("packages/client/src/services/privatePhotoCacheLifecycle.ts"),
    source("packages/client/src/services/privateCachePurge.ts"),
    source("packages/client/src/contexts/AuthContext.tsx"),
    source("packages/client/src/services/http.ts"),
  ]);

  assert.match(lifecycle, /import\("\.\/privateCachePurge\.ts"\)/);
  assert.doesNotMatch(
    lifecycle,
    /import\s+(?!type\b)[^;]+from "\.\/privateCachePurge\.ts"/,
  );
  for (const marker of ["workbox-expiration", "cache-entries", "openKeyCursor("]) {
    assert.ok(cleanup.includes(marker), `lazy cleanup must own ${marker}`);
    assert.ok(!lifecycle.includes(marker), `static lifecycle shell must not own ${marker}`);
  }
  assert.doesNotMatch(cleanup, /cursor\.(?:value|primaryKey)/);
  assert.match(
    lifecycle,
    /await cleanup\.deletePrivateCaches\(cacheNames, activePersistentWrites, resumeCaching\)/,
  );
  assert.ok(!auth.includes("void clearPrivatePhotoCaches()"));
  assert.match(auth, /await clearPrivatePhotoCaches\(\)/);
  assert.match(auth, /setUnauthorizedHandler\(async \(failedToken\)/);
  assert.match(http, /await _onUnauthorized\?\.\(requestToken\)/);
  assert.match(http, /await _onUnauthorized\?\.\(null\)/);
  assert.doesNotMatch(
    lifecycle.slice(lifecycle.indexOf('import("./privateCachePurge.ts")')),
    /\.catch\(/,
    "chunk-load failures must reject the lifecycle cleanup promise",
  );
});

test("API hedge machinery stays behind an authenticated intent boundary", async () => {
  const [app, http, routing, hedge] = await Promise.all([
    source("packages/client/src/App.tsx"),
    source("packages/client/src/services/http.ts"),
    source("packages/client/src/services/apiRoutingPolicy.ts"),
    source("packages/client/src/services/apiHedgePolicy.ts"),
  ]);

  assert.match(http, /import\("\.\/apiHedgePolicy"\)/);
  assert.doesNotMatch(
    http,
    /import\s+(?!type\b)[^;]+from "\.\/apiHedgePolicy"/,
  );
  assert.match(
    http,
    /await waitForResult\(\s*preloadApiHedgePolicy\(\),\s*init\?\.signal \?\? undefined,\s*\)/,
  );
  assert.match(app, /preloadApiHedgePolicy\(\)\.catch\(reportLazyBoundaryFailure\)/);
  assert.ok(!routing.includes("raceHedgedAttempts"));
  assert.match(hedge, /export function raceHedgedAttempts/);
  assert.match(hedge, /Hedged request lost/);
});

test("built deferred support chunks stay outside login preload and service-worker precache", async () => {
  const assetNames = await readdir(new URL("assets/", distPath));
  const deploymentManifest = JSON.parse(
    await readFile(new URL("deployment-assets.json", distPath), "utf8"),
  );
  const currentAssetNames = new Set(
    deploymentManifest.generations[0].assets.map(
      ({ path }) => path.replace(/^assets\//, ""),
    ),
  );
  const currentAssets = assetNames.filter((name) => currentAssetNames.has(name));
  const entryNames = currentAssets.filter((name) => /^index-[\w-]{8,}\.js$/.test(name));
  const cleanupNames = currentAssets.filter(
    (name) => /^privateCachePurge-[\w-]{8,}\.js$/.test(name),
  );
  const hedgeNames = currentAssets.filter(
    (name) => /^apiHedgePolicy-[\w-]{8,}\.js$/.test(name),
  );
  assert.equal(entryNames.length, 1, "build must emit exactly one login entry");
  assert.equal(cleanupNames.length, 1, "build must emit exactly one lazy Workbox cleanup chunk");
  assert.equal(hedgeNames.length, 1, "build must emit exactly one lazy API hedge chunk");

  const entryPath = new URL(`assets/${entryNames[0]}`, distPath);
  const cleanupPath = new URL(`assets/${cleanupNames[0]}`, distPath);
  const hedgePath = new URL(`assets/${hedgeNames[0]}`, distPath);
  const [entry, cleanup, hedge, html, serviceWorker, entryStats] = await Promise.all([
    readFile(entryPath, "utf8"),
    readFile(cleanupPath, "utf8"),
    readFile(hedgePath, "utf8"),
    readFile(new URL("index.html", distPath), "utf8"),
    readFile(new URL("sw.js", distPath), "utf8"),
    stat(entryPath),
  ]);
  for (const marker of ["workbox-expiration", "cache-entries"]) {
    assert.ok(!entry.includes(marker), `login entry must not contain ${marker}`);
    assert.ok(cleanup.includes(marker), `lazy cleanup chunk must contain ${marker}`);
  }
  assert.ok(!entry.includes("Hedged request lost"));
  assert.ok(hedge.includes("Hedged request lost"));
  assert.ok(
    !html.includes(cleanupNames[0]),
    "unauthenticated HTML must not preload the private cleanup chunk",
  );
  assert.ok(
    !serviceWorker.includes(`assets/${cleanupNames[0]}`),
    "service worker must not precache the private cleanup chunk",
  );
  assert.ok(
    !html.includes(hedgeNames[0]),
    "unauthenticated HTML must not preload the API hedge chunk",
  );
  assert.ok(
    !serviceWorker.includes(`assets/${hedgeNames[0]}`),
    "service worker must not precache the API hedge chunk",
  );
  assert.ok(
    entryStats.size <= 36_000,
    `login entry must stay within the 36,000-byte raw budget; received ${entryStats.size}`,
  );

  console.log(JSON.stringify({
    entry: entryNames[0],
    rawBytes: entryStats.size,
    gzipBytes: gzipSync(entry).byteLength,
    lazyCleanup: cleanupNames[0],
    lazyApiHedge: hedgeNames[0],
  }));
});

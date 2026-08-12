#!/usr/bin/env node

import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const distPath = new URL("packages/client/dist/", root);

test("private cache degradation notice is claimed once per app session", async () => {
  const notice = await import(
    "../packages/client/src/services/privateCacheDegradationNotice.ts"
  );
  assert.equal(notice.claimPrivateCacheDegradationNotice(), true);
  assert.equal(notice.claimPrivateCacheDegradationNotice(), false);
  assert.equal(
    notice.claimPrivateCacheDegradationNotice(),
    false,
    "logout and a second successful login must not repeat the same warning",
  );
});

test("private media reads stay fenced after rejected or late cleanup", async () => {
  const { privateCacheWriteFence } = await import("../packages/client/vite.config.mts");
  const guard = globalThis;
  guard.__cloudPhotoPrivateCacheFenceReady = Promise.resolve();
  guard.__cloudPhotoPrivateCacheGeneration = 7;
  guard.__cloudPhotoPrivateCacheEnabled = true;
  const state = {};
  await privateCacheWriteFence.handlerWillStart({ state });
  const cachedResponse = new Response("stale private media");
  assert.equal(
    await privateCacheWriteFence.cachedResponseWillBeUsed({ cachedResponse, state }),
    cachedResponse,
  );
  guard.__cloudPhotoPrivateCacheEnabled = false;
  assert.equal(
    await privateCacheWriteFence.cachedResponseWillBeUsed({ cachedResponse, state }),
    null,
    "a rejected cleanup must make an existing cached response unreadable",
  );
  guard.__cloudPhotoPrivateCacheEnabled = true;
  guard.__cloudPhotoPrivateCacheGeneration = 8;
  assert.equal(
    await privateCacheWriteFence.cachedResponseWillBeUsed({ cachedResponse, state }),
    null,
    "a late prior-generation request must not read private cached media",
  );
  assert.equal(
    await privateCacheWriteFence.cacheWillUpdate({ response: cachedResponse, state }),
    null,
    "a late prior-generation response must remain unwritable",
  );
  delete guard.__cloudPhotoPrivateCacheFenceReady;
  delete guard.__cloudPhotoPrivateCacheGeneration;
  delete guard.__cloudPhotoPrivateCacheEnabled;
});

test("private Workbox cleanup stays behind an awaited dynamic boundary", async () => {
  const [lifecycle, listLifecycle, reset, cleanup, auth, authPage, http, app] = await Promise.all([
    source("packages/client/src/services/privatePhotoCacheLifecycle.ts"),
    source("packages/client/src/services/privatePhotoListCacheLifecycle.ts"),
    source("packages/client/src/services/privateCacheReset.ts"),
    source("packages/client/src/services/privateCachePurge.ts"),
    source("packages/client/src/contexts/AuthContext.tsx"),
    source("packages/client/src/components/auth/AuthPage.tsx"),
    source("packages/client/src/services/http.ts"),
    source("packages/client/src/AuthenticatedApp.tsx"),
  ]);

  assert.match(reset, /import\("\.\/privateCachePurge\.ts"\)/);
  assert.doesNotMatch(
    lifecycle,
    /import\s+(?!type\b)[^;]+from "\.\/privateCachePurge\.ts"/,
  );
  for (const marker of ["workbox-expiration", "cache-entries", "openKeyCursor("]) {
    assert.ok(cleanup.includes(marker), `lazy cleanup must own ${marker}`);
    assert.ok(!lifecycle.includes(marker), `static lifecycle shell must not own ${marker}`);
  }
  assert.doesNotMatch(cleanup, /cursor\.(?:value|primaryKey)/);
  assert.match(lifecycle, /await reset\.resetPrivateCaches\(/);
  assert.match(listLifecycle, /await reset\.resetPrivateCaches\(/);
  assert.doesNotMatch(lifecycle, /listCleanupChain/);
  assert.match(reset, /await beginPrivateCacheReset\(/);
  assert.match(reset, /await cleanup\.purgePrivateWorkboxExpirationMetadata\(/);
  assert.match(reset, /await completePrivateCacheReset\(/);
  assert.match(reset, /PRIVATE_CACHE_RESET_TIMEOUT_MS = 2_000/);
  assert.match(reset, /Promise\.race\(\[operation, deadline\]\)/);
  assert.match(reset, /Date\.now\(\) \+ PRIVATE_CACHE_RESET_TIMEOUT_MS/);
  assert.match(reset, /deadlineExpired \|\| Date\.now\(\) >= deadlineAt/);
  assert.match(reset, /beginPrivateCacheFence\(isCurrent, deadlineAt\)/);
  assert.match(reset, /expiresAt/);
  assert.match(cleanup, /openKeyCursor\(/);
  assert.ok(
    reset.indexOf("beforeFinalize();") < reset.indexOf("await completePrivateCacheReset("),
    "the deadline must stop before the bounded fence-resume commit starts",
  );
  assert.doesNotMatch(lifecycle, /PRIVATE_CACHE_RESET_TIMEOUT_MS/);
  assert.ok(reset.includes("cacheStorage.delete(name)"));
  assert.match(reset, /typeof cacheStorage\.delete !== "function"/);
  assert.ok(
    reset.indexOf("await beginPrivateCacheReset(")
      < reset.indexOf('import("./privateCachePurge.ts")'),
    "Cache Storage fallback and the worker fence must run before the purge chunk loads",
  );
  assert.ok(!auth.includes("void clearPrivatePhotoCaches()"));
  assert.match(auth, /await clearPrivatePhotoCaches\(\)/);
  assert.match(auth, /setUnauthorizedHandler\(async \(failedToken\)/);
  assert.match(http, /await _onUnauthorized\?\.\(requestToken\)/);
  assert.match(http, /await _onUnauthorized\?\.\(null\)/);
  assert.doesNotMatch(
    lifecycle,
    /\.catch\(/,
    "chunk-load failures must reject the lifecycle cleanup promise",
  );
  assert.match(reset, /failures\.push\(error\)/);
  assert.match(
    reset,
    /await completePrivateCacheReset\(\s*reset,\s*resumeCaching,\s*failures,\s*fencePrivateMediaWrites,\s*\)/,
  );
  assert.match(app, /claimPrivateCacheDegradationNotice\(\)/);
  const noticeStart = app.indexOf("const reportPrivateCacheDegradation");
  const noticeBody = app.slice(noticeStart, app.indexOf("useEffect", noticeStart));
  assert.ok(noticeStart >= 0);
  assert.doesNotMatch(
    noticeBody,
    /error\.message|String\(error\)/,
    "private-cache failures must not reach a raw toast",
  );
  assert.ok(
    (app.match(/reportPrivateCacheDegradation\(error\)/g) ?? []).length >= 2,
    "preparation and logout degradation must share the deduplicated notice path",
  );
  const loginStart = authPage.indexOf("const handleLogin");
  const loginBody = authPage.slice(loginStart, authPage.indexOf("const switchTab", loginStart));
  assert.ok(loginStart >= 0);
  assert.ok(
    loginBody.indexOf('setError("")') < loginBody.indexOf("await login("),
    "every login attempt must clear stale authentication errors before authentication",
  );
  assert.doesNotMatch(
    loginBody.slice(loginBody.indexOf("await login("), loginBody.indexOf("catch")),
    /setError\(/,
    "a successful login must leave authentication errors cleared",
  );
  for (const privateCacheSource of [reset, cleanup, lifecycle, app]) {
    assert.doesNotMatch(
      privateCacheSource,
      /Private cache cleanup failed/i,
      "raw private-cache implementation errors must not ship in current client source",
    );
  }
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
  const currentJavaScriptAssets = currentAssets.filter((name) => name.endsWith(".js"));
  const entryNames = currentAssets.filter((name) => /^index-[\w-]{8,}\.js$/.test(name));
  const cleanupNames = currentAssets.filter(
    (name) => /^privateCachePurge-[\w-]{8,}\.js$/.test(name),
  );
  const hedgeNames = currentAssets.filter(
    (name) => /^apiHedgePolicy-[\w-]{8,}\.js$/.test(name),
  );
  const resetNames = currentAssets.filter(
    (name) => /^privateCacheReset-[\w-]{8,}\.js$/.test(name),
  );
  assert.equal(entryNames.length, 1, "build must emit exactly one login entry");
  assert.equal(cleanupNames.length, 1, "build must emit exactly one lazy Workbox cleanup chunk");
  assert.equal(hedgeNames.length, 1, "build must emit exactly one lazy API hedge chunk");
  assert.equal(resetNames.length, 1, "build must emit exactly one precached private reset chunk");

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
  const currentJavaScript = new Map(await Promise.all(
    currentJavaScriptAssets.map(async (name) => [
      name,
      await readFile(new URL(`assets/${name}`, distPath), "utf8"),
    ]),
  ));
  const reachable = new Set(entryNames);
  const pending = [...entryNames];
  while (pending.length > 0) {
    const name = pending.pop();
    const contents = currentJavaScript.get(name);
    assert.ok(contents, `current dependency ${name} must exist in the build`);
    for (const candidate of currentJavaScriptAssets) {
      if (
        !reachable.has(candidate)
        && (
          contents.includes(`./${candidate}`)
          || contents.includes(`/assets/${candidate}`)
        )
      ) {
        reachable.add(candidate);
        pending.push(candidate);
      }
    }
  }
  assert.ok(
    [...reachable].some((name) => /^privateCacheReset-/.test(name)),
    "the active login graph must include its current private-cache reset chunk",
  );
  assert.ok(
    [...reachable].some((name) => /^privateCachePurge-/.test(name)),
    "the active login graph must include its current private-cache purge dependency",
  );
  for (const name of reachable) {
    assert.doesNotMatch(
      currentJavaScript.get(name),
      /Private cache cleanup failed/i,
      `current reachable chunk ${name} must not expose a raw private-cache failure`,
    );
  }
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
    serviceWorker.includes(`assets/${resetNames[0]}`),
    "service worker must precache the minimal cache/fence fallback",
  );
  assert.ok(
    !html.includes(resetNames[0]),
    "unauthenticated HTML must not preload the private reset chunk",
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

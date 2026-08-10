#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relativePath) => readFile(join(root, relativePath), "utf8");

const values = new Map();
let afterSetItem = null;
globalThis.localStorage = {
  getItem(key) {
    return values.get(key) ?? null;
  },
  setItem(key, value) {
    const stored = String(value);
    values.set(key, stored);
    Object.defineProperty(this, key, {
      value: stored,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    const hook = afterSetItem;
    afterSetItem = null;
    hook?.(key);
  },
  removeItem(key) {
    values.delete(key);
    delete this[key];
  },
  key(index) {
    return [...values.keys()][index] ?? null;
  },
  get length() {
    return values.size;
  },
  clear() {
    for (const key of values.keys()) delete this[key];
    values.clear();
  },
};

const availableCacheNames = new Set(["workbox-precache-v2", "photo-media-v1"]);
globalThis.window = {
  caches: {
    async delete(name) {
      availableCacheNames.delete(name);
      return true;
    },
  },
};

const lifecycle = await import("../packages/client/src/services/privatePhotoCacheLifecycle.ts");
const momentsStore = await import("../packages/client/src/services/privateMomentsStore.ts");

const insight = {
  photoName: "private/photo.jpg",
  totalViews: 2,
  lastViewedAt: "2026-08-10T12:00:00.000Z",
  lastViewedBy: "viewer",
  viewers: { viewer: 2 },
  dailyViews: { "2026-08-10": 2 },
};

localStorage.setItem("cloudphoto_moments_insights_v1", JSON.stringify({ [insight.photoName]: insight }));
localStorage.setItem("cloudphoto_moments_diagnostics_v1", JSON.stringify({ status: "local-only" }));
await lifecycle.preparePrivatePhotoCachesForScope("account-a:viewer");
assert.equal(values.has("cloudphoto_moments_insights_v1"), false, "legacy insights must be deleted, not adopted");
assert.equal(values.has("cloudphoto_moments_diagnostics_v1"), false, "legacy diagnostics must be deleted, not adopted");
assert.deepEqual(momentsStore.readPrivateMomentInsights("personal"), {}, "unowned legacy data must stay unreadable");

const accountAWrite = momentsStore.capturePrivateMomentsContext("personal");
assert(accountAWrite, "an authenticated scope must create a write context");
assert.equal(
  await momentsStore.writePrivateMomentInsights(accountAWrite, { [insight.photoName]: insight }),
  true,
);
assert.deepEqual(
  momentsStore.readPrivateMomentInsights("personal"),
  { [insight.photoName]: insight },
  "the current account and workspace may restore their own local fallback",
);
assert.deepEqual(
  momentsStore.readPrivateMomentInsights("group-b"),
  {},
  "moments must not cross workspace/group boundaries",
);

let resetCount = 0;
const unregisterReset = lifecycle.registerPrivatePhotoCacheReset((scopeReset) => {
  if (!scopeReset) return;
  resetCount += 1;
});
const pendingMutationWrite = momentsStore.capturePrivateMomentsContext("personal");
await lifecycle.invalidatePhotoListCaches();
assert.equal(resetCount, 0, "ordinary photo-list invalidation must not reset moments");
assert.deepEqual(
  momentsStore.readPrivateMomentInsights("personal"),
  { [insight.photoName]: insight },
  "ordinary photo mutations must preserve the current scoped offline fallback",
);
assert.equal(
  await momentsStore.writePrivateMomentInsights(pendingMutationWrite, { [insight.photoName]: insight }),
  true,
  "ordinary photo-list invalidation must not cancel a pending moments write",
);
const writerOne = momentsStore.capturePrivateMomentsContext("shared-group");
const writerTwo = momentsStore.capturePrivateMomentsContext("shared-group");
let sharedUpdates = 0;
const unsubscribeShared = momentsStore.subscribePrivateMomentInsights("shared-group", () => {
  sharedUpdates += 1;
});
momentsStore.mutatePrivateMomentInsights(writerOne, (current) => ({
  ...current,
  [insight.photoName]: { ...insight, totalViews: 3 },
}));
momentsStore.mutatePrivateMomentInsights(writerTwo, (current) => ({
  ...current,
  [insight.photoName]: {
    ...current[insight.photoName],
    totalViews: current[insight.photoName].totalViews + 1,
  },
}));
assert.equal(
  momentsStore.readPrivateMomentInsights("shared-group")[insight.photoName].totalViews,
  4,
  "kept-mounted galleries must mutate one shared workspace snapshot",
);
assert.equal(sharedUpdates, 2, "both local mutations must publish to sibling galleries");
assert.equal(
  await momentsStore.writePrivateMomentInsights(writerOne, {
    [insight.photoName]: { ...insight, totalViews: 3 },
  }),
  true,
);
assert.equal(
  await momentsStore.writePrivateMomentInsights(writerTwo, {
    [insight.photoName]: { ...insight, totalViews: 4 },
  }),
  true,
);
const sharedStorageKey = momentsStore.privateMomentsStorageKey("insights", writerTwo);
assert.equal(
  JSON.parse(values.get(sharedStorageKey))[insight.photoName].totalViews,
  4,
  "a stale full snapshot must not overwrite a newer persisted view count",
);
unsubscribeShared();
const crossTabCounterContext = momentsStore.capturePrivateMomentsContext("counter-group");
assert.equal(
  await momentsStore.writePrivateMomentInsights(crossTabCounterContext, {
    [insight.photoName]: { ...insight, totalViews: 5 },
  }),
  true,
);
await Promise.all([
  momentsStore.recordPrivateMomentViewLocally(
    momentsStore.capturePrivateMomentsContext("counter-group"),
    insight.photoName,
    "viewer",
    "2026-08-10T12:01:00.000Z",
  ),
  momentsStore.recordPrivateMomentViewLocally(
    momentsStore.capturePrivateMomentsContext("counter-group"),
    insight.photoName,
    "viewer",
    "2026-08-10T12:02:00.000Z",
  ),
]);
const counterStorageKey = momentsStore.privateMomentsStorageKey("insights", crossTabCounterContext);
assert.equal(
  JSON.parse(values.get(counterStorageKey))[insight.photoName].totalViews,
  7,
  "serialized offline deltas must preserve concurrent view increments",
);
assert(
  String(await read("packages/client/src/services/privateMomentsStore.ts"))
    .includes("navigator.locks.request"),
  "cross-tab offline increments must use the browser lock boundary",
);
const rebaseContext = momentsStore.capturePrivateMomentsContext("rebase-group");
await momentsStore.writePrivateMomentInsights(rebaseContext, {
  [insight.photoName]: { ...insight, totalViews: 5 },
});
let rebasedVisibleCount = 0;
const unsubscribeRebase = momentsStore.subscribePrivateMomentInsights("rebase-group", (map) => {
  rebasedVisibleCount = map[insight.photoName]?.totalViews ?? 0;
});
const rebaseStorageKey = momentsStore.privateMomentsStorageKey("insights", rebaseContext);
localStorage.setItem(rebaseStorageKey, JSON.stringify({
  [insight.photoName]: { ...insight, totalViews: 6 },
}));
await momentsStore.recordPrivateMomentViewLocally(
  rebaseContext,
  insight.photoName,
  "viewer",
  "2026-08-10T12:03:00.000Z",
);
assert.equal(
  JSON.parse(values.get(rebaseStorageKey))[insight.photoName].totalViews,
  7,
  "a locked delta must rebase on the latest cross-tab snapshot",
);
assert.equal(rebasedVisibleCount, 7, "rebased persistence must publish back to mounted galleries");
await momentsStore.writePrivateMomentInsights(rebaseContext, {
  [insight.photoName]: { ...insight, totalViews: 6 },
});
assert.equal(
  JSON.parse(values.get(rebaseStorageKey))[insight.photoName].totalViews,
  7,
  "a delayed server response must not double-count or regress the local delta",
);
unsubscribeRebase();
const staleContext = momentsStore.capturePrivateMomentsContext("personal");
const switchPromise = lifecycle.preparePrivatePhotoCachesForScope("account-b:admin");
assert.equal(resetCount, 1, "account/role switches must synchronously clear in-memory consumers");
assert.deepEqual(momentsStore.readPrivateMomentInsights("personal"), {}, "old moments must be unreadable before auth UI updates");
assert.equal(
  await momentsStore.writePrivateMomentInsights(staleContext, { [insight.photoName]: insight }),
  false,
  "a stale in-flight write must be rejected by owner/generation fencing",
);
assert.equal(values.has("cloudphoto_moments_insights_v1"), false, "stale writes must not recreate legacy keys");
await switchPromise;
unregisterReset();

const accountBContext = momentsStore.capturePrivateMomentsContext("personal");
assert(accountBContext);
const oversizedName = "x".repeat(momentsStore.PRIVATE_MOMENTS_MAX_BYTES);
assert.equal(
  await momentsStore.writePrivateMomentInsights(accountBContext, {
    [oversizedName]: { ...insight, photoName: oversizedName },
  }),
  false,
  "oversized local JSON must be rejected",
);
assert.deepEqual(momentsStore.readPrivateMomentInsights("personal"), {});

const storageKey = momentsStore.privateMomentsStorageKey("insights", accountBContext);
values.set(storageKey, "{broken");
assert.deepEqual(momentsStore.readPrivateMomentInsights("personal"), {}, "malformed local JSON must fail closed");
assert.equal(values.has(storageKey), false, "malformed private data must be removed");

assert.equal(
  momentsStore.writePrivateMomentsDiagnostics(accountBContext, "server-synced", { photoCount: 1 }),
  true,
);
assert.equal(momentsStore.readPrivateMomentsDiagnostics("personal").photoCount, 1);
assert.deepEqual(momentsStore.readPrivateMomentsDiagnostics("group-b"), {
  status: "unknown",
});

const crossTabRaceContext = momentsStore.capturePrivateMomentsContext("personal");
const raceInsightsKey = momentsStore.privateMomentsStorageKey("insights", crossTabRaceContext);
afterSetItem = () => localStorage.removeItem("cloudphoto_private_cache_owner_v1");
assert.equal(
  await momentsStore.writePrivateMomentInsights(crossTabRaceContext, { [insight.photoName]: insight }),
  false,
  "a cross-tab owner change during setItem must reject the stale write",
);
assert.equal(values.has(raceInsightsKey), false, "a rejected cross-tab write must be rolled back");
await lifecycle.preparePrivatePhotoCachesForScope("account-b:admin");
const diagnosticsRaceContext = momentsStore.capturePrivateMomentsContext("personal");
const raceDiagnosticsKey = momentsStore.privateMomentsStorageKey("diagnostics", diagnosticsRaceContext);
afterSetItem = () => localStorage.removeItem("cloudphoto_private_cache_owner_v1");
assert.equal(
  momentsStore.writePrivateMomentsDiagnostics(diagnosticsRaceContext, "local-only", { photoCount: 1 }),
  false,
);
assert.equal(values.has(raceDiagnosticsKey), false, "stale diagnostics writes must also be rolled back");
await lifecycle.preparePrivatePhotoCachesForScope("account-b:admin");

await lifecycle.clearPrivatePhotoCaches();
assert.deepEqual(momentsStore.readPrivateMomentInsights("personal"), {}, "logout/401 must delete scoped moments");
assert.equal(availableCacheNames.has("photo-media-v1"), false, "logout must still remove private media");
assert.equal(availableCacheNames.has("workbox-precache-v2"), true, "logout must preserve the private app shell");

const auth = await read("packages/client/src/contexts/AuthContext.tsx");
const logoutStart = auth.indexOf("const logout = useCallback");
const logoutBody = auth.slice(logoutStart, auth.indexOf("useEffect", logoutStart));
assert(
  logoutBody.indexOf("void clearPrivatePhotoCaches()") < logoutBody.indexOf("setUser(null)"),
  "explicit logout and 401 logout must revoke private data before clearing auth state",
);
assert(
  auth.includes("setUnauthorizedHandler((failedToken) => {")
  && auth.includes("if (!failedToken || getToken() === failedToken) logout();"),
  "the active-token 401 path must use the same private-data logout boundary",
);
const crossTabStart = auth.indexOf("const handleStorage");
assert(crossTabStart >= 0);
const crossTabBody = auth.slice(crossTabStart, auth.indexOf("window.addEventListener", crossTabStart));
assert(
  crossTabBody.indexOf("void clearPrivatePhotoCaches()") < crossTabBody.indexOf("setUser(null)"),
  "cross-tab account replacement must invalidate private data before clearing auth state",
);
assert(
  auth.includes("if (!getToken()) {\n      void clearPrivatePhotoCaches();"),
  "invalid or absent token restore must fail closed and remove orphaned private data",
);
assert(
  auth.includes("getTokenAuthScope() !== restoredScope")
  && auth.includes("preparePrivatePhotoCachesForScope(restoredScope)"),
  "restored sessions must validate and prepare the exact account/role scope before publishing the user",
);
assert(
  auth.includes("replacementScope && replacementScope === currentScope"),
  "same-account cross-tab token rotation may preserve its own scope",
);

const gallery = await read("packages/client/src/components/gallery/PhotoGallery.tsx");
const app = await read("packages/client/src/AuthenticatedApp.tsx");
const settings = await read("packages/client/src/components/settings/SettingsDialog.tsx");
for (const [label, source] of [["gallery", gallery], ["home", app], ["settings", settings]]) {
  assert(!source.includes('"cloudphoto_moments_insights_v1"'), `${label} must not read the global legacy insights key`);
  assert(!source.includes('"cloudphoto_moments_diagnostics_v1"'), `${label} must not read the global legacy diagnostics key`);
}
assert(gallery.includes("registerPrivatePhotoCacheReset"), "PhotoGallery must clear moments state on lifecycle reset");
assert(gallery.includes("await localWrite;"), "server reconciliation must wait for its matching local delta");
assert(app.includes("readPrivateMomentsDiagnostics"), "home diagnostics must use the scoped helper");
assert(settings.includes("readPrivateMomentsDiagnostics"), "Settings diagnostics must use the scoped helper");

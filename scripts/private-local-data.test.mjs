#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

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
let cacheDeleteFailure = null;
let beforeCacheDelete = null;
const lifecycleEvents = [];
globalThis.window = {
  caches: {
    async delete(name) {
      await beforeCacheDelete?.(name);
      if (name === cacheDeleteFailure) throw new Error("fake cache deletion failure");
      availableCacheNames.delete(name);
      return true;
    },
  },
  dispatchEvent(event) {
    lifecycleEvents.push(event.type);
    return true;
  },
};
globalThis.caches = globalThis.window.caches;

const lifecycleSource = await read("packages/client/src/services/privatePhotoCacheLifecycle.ts");
const listLifecycleSource = await read(
  "packages/client/src/services/privatePhotoListCacheLifecycle.ts",
);
const resetSource = await read("packages/client/src/services/privateCacheReset.ts");
const expirationMetadataSource = await read("packages/client/src/services/privateCachePurge.ts");
assert(
  resetSource.includes('import("./privateCachePurge.ts")'),
  "the reset boundary must load Workbox expiration cleanup only after its fallback starts",
);
assert(
  lifecycleSource.includes("await reset.resetPrivateCaches("),
  "private cleanup must await the precached Cache Storage reset boundary",
);
assert(
  listLifecycleSource.includes("await reset.resetPrivateCaches("),
  "list-only cleanup must await its authenticated reset boundary",
);
assert(
  !lifecycleSource.includes("listCleanupChain"),
  "list-only orchestration must stay outside the login entry dependency",
);
assert(
  resetSource.includes("await cleanup.purgePrivateWorkboxExpirationMetadata("),
  "private cleanup must await the dynamically loaded Workbox metadata purge",
);
assert(
  lifecycleSource.includes("if (expectedGeneration !== cacheGeneration) return false"),
  "generation drift must block replacement-owner adoption",
);
for (const implementationMarker of [
  '"workbox-expiration"',
  '"cache-entries"',
  "openKeyCursor(",
]) {
  assert(
    !lifecycleSource.includes(implementationMarker),
    `${implementationMarker} must not remain in the login entry dependency`,
  );
  assert(
    expirationMetadataSource.includes(implementationMarker),
    `${implementationMarker} must live in the deferred cleanup implementation`,
  );
  assert(
    !resetSource.includes(implementationMarker),
    `${implementationMarker} must stay out of the precached Cache Storage fallback`,
  );
}
assert(resetSource.includes("cacheStorage.delete(name)"));
assert(resetSource.includes('typeof cacheStorage.delete !== "function"'));
assert(resetSource.includes("markCleanupComplete = true"));
assert(resetSource.includes("beginPrivateCacheFence"));
for (const sensitiveRead of ["cursor.value", "cursor.primaryKey"]) {
  assert(
    !expirationMetadataSource.includes(sensitiveRead),
    `${sensitiveRead} must not materialize private URLs or SAS values during cleanup`,
  );
}

{
  const fenceSource = await read("packages/client/public/private-cache-fence.js");
  const cacheRows = new Map();
  let failStateWrite = false;
  const fakeCaches = {
    async open(name) {
      return {
        async match(request) {
          return cacheRows.get(`${name}:${request.url}`)?.clone();
        },
        async put(request, response) {
          if (failStateWrite) throw new Error("synthetic fence persistence failure");
          cacheRows.set(`${name}:${request.url}`, response.clone());
        },
        async delete(request) {
          return cacheRows.delete(`${name}:${request.url}`);
        },
      };
    },
  };
  const startWorker = async () => {
    let messageHandler;
    const worker = {
      location: { origin: "https://synthetic.invalid" },
      addEventListener(type, handler) {
        if (type === "message") messageHandler = handler;
      },
    };
    runInNewContext(fenceSource, {
      self: worker,
      caches: fakeCaches,
      Request,
      Response,
      URL,
      JSON,
      Number,
      Promise,
    });
    await worker.__cloudPhotoPrivateCacheFenceReady;
    return { worker, messageHandler };
  };
  const sendFenceCommand = async (
    { messageHandler },
    command,
    generation,
    expiresAt,
  ) => {
    const channel = new MessageChannel();
    const reply = new Promise((resolve) => {
      channel.port1.onmessage = ({ data }) => {
        channel.port1.close();
        channel.port2.close();
        resolve(data);
      };
    });
    let pending;
    messageHandler({
      data: {
        type: "cloudphoto-private-cache-fence",
        command,
        generation,
        expiresAt,
      },
      ports: [channel.port2],
      waitUntil(operation) {
        pending = operation;
      },
    });
    await pending;
    return reply;
  };

  const firstWorker = await startWorker();
  assert.equal(firstWorker.worker.__cloudPhotoPrivateCacheEnabled, false);
  assert.equal((await sendFenceCommand(firstWorker, "enable")).ok, true);
  assert.equal(firstWorker.worker.__cloudPhotoPrivateCacheEnabled, true);
  assert.equal(
    (await sendFenceCommand(firstWorker, "begin", undefined, Date.now() - 1)).ok,
    false,
    "an expired cleanup command must not disable a newer authenticated worker",
  );
  assert.equal(firstWorker.worker.__cloudPhotoPrivateCacheEnabled, true);

  const restartedWorker = await startWorker();
  assert.equal(
    restartedWorker.worker.__cloudPhotoPrivateCacheEnabled,
    true,
    "worker restart must restore the validated authenticated cache state",
  );
  const cleanup = await sendFenceCommand(restartedWorker, "begin");
  assert.equal(restartedWorker.worker.__cloudPhotoPrivateCacheEnabled, false);

  const cleanupWorker = await startWorker();
  assert.equal(
    (await sendFenceCommand(cleanupWorker, "enable")).ok,
    false,
    "worker restart must preserve and refuse to supersede an active cleanup",
  );
  assert.equal(
    (await sendFenceCommand(cleanupWorker, "complete", cleanup.generation)).ok,
    true,
  );
  const loggedOutWorker = await startWorker();
  assert.equal(loggedOutWorker.worker.__cloudPhotoPrivateCacheEnabled, false);
  failStateWrite = true;
  assert.equal((await sendFenceCommand(loggedOutWorker, "enable")).ok, false);
  assert.equal(
    loggedOutWorker.worker.__cloudPhotoPrivateCacheEnabled,
    false,
    "writes must remain disabled until an enabling state is durably persisted",
  );
  failStateWrite = false;
  const failedPersistenceRestart = await startWorker();
  assert.equal(
    failedPersistenceRestart.worker.__cloudPhotoPrivateCacheEnabled,
    false,
    "failed persistence must remove stale enabled state before worker restart",
  );
}

const lifecycle = await import("../packages/client/src/services/privatePhotoCacheLifecycle.ts");
const listLifecycle = await import(
  "../packages/client/src/services/privatePhotoListCacheLifecycle.ts"
);
const cacheReset = await import("../packages/client/src/services/privateCacheReset.ts");
const workboxCleanup = await import("../packages/client/src/services/privateCachePurge.ts");
const momentsStore = await import("../packages/client/src/services/privateMomentsStore.ts");
const dateFormat = await import("../packages/client/src/utils/dateFormat.ts");
const shareStore = await import("../packages/client/src/services/share/shareLinksStore.ts");
const privateCacheNames = [
  "cloudphoto-photo-lists-v1",
  "photo-media-v1",
  "cf-media-v1",
];

function createFakeWorkboxExpirationDb(
  entries,
  {
    includeDatabase = true,
    includeStore = true,
    includeIndex = true,
    inventoryError = false,
    openOutcome = "success",
    readwriteOutcome = "complete",
    trapSensitiveReads = false,
    onClose,
  } = {},
) {
  const rows = new Map(entries.map((entry) => [entry.id, { ...entry }]));
  let openCount = 0;
  const openedDatabaseNames = [];
  const transactions = [];

  const db = {
    objectStoreNames: {
      contains: (name) => includeStore && name === "cache-entries",
    },
    transaction(storeName, mode) {
      transactions.push({ storeName, mode });
      const stagedDeletes = [];
      let pendingCursors = 0;
      let outcomeScheduled = false;
      let aborted = false;
      const transaction = {
        error: null,
        abort() {
          if (aborted) return;
          aborted = true;
          transaction.error = new DOMException("Synthetic transaction abort", "AbortError");
          queueMicrotask(() => transaction.onabort?.());
        },
        objectStore() {
          return {
            indexNames: {
              contains: (name) => includeIndex && name === "cacheName",
            },
            openCursor() {
              throw new Error("full-store cursor access is forbidden");
            },
            index(name) {
              if (!includeIndex || name !== "cacheName") {
                throw new DOMException("Synthetic missing index", "NotFoundError");
              }
              return {
                openKeyCursor(cacheName) {
                  const request = {};
                  const matchingRows = [...rows.values()].filter(
                    (entry) => entry.cacheName === cacheName,
                  );
                  let cursorIndex = 0;
                  pendingCursors += 1;
                  const finishTransaction = () => {
                    pendingCursors -= 1;
                    if (pendingCursors !== 0 || outcomeScheduled || aborted) return;
                    outcomeScheduled = true;
                    queueMicrotask(() => {
                      if (aborted) return;
                      if (readwriteOutcome === "complete") {
                        for (const key of stagedDeletes) rows.delete(key);
                        transaction.oncomplete?.();
                      } else {
                        transaction.error = new DOMException(
                          `Synthetic readwrite ${readwriteOutcome}`,
                          readwriteOutcome === "abort" ? "AbortError" : "UnknownError",
                        );
                        transaction[`on${readwriteOutcome}`]?.();
                      }
                    });
                  };
                  const advance = () => {
                    const value = matchingRows[cursorIndex++];
                    if (!value) {
                      request.result = null;
                      request.onsuccess?.();
                      finishTransaction();
                      return;
                    }
                    const cursor = {
                      delete() {
                        stagedDeletes.push(value.id);
                        return {};
                      },
                      continue: () => queueMicrotask(advance),
                    };
                    if (trapSensitiveReads) {
                      for (const property of ["key", "primaryKey", "value"]) {
                        Object.defineProperty(cursor, property, {
                          get() {
                            throw new Error(`sensitive cursor field read: ${property}`);
                          },
                        });
                      }
                    }
                    request.result = cursor;
                    request.onsuccess?.();
                  };
                  queueMicrotask(advance);
                  return request;
                },
              };
            },
          };
        },
      };
      return transaction;
    },
    close() {
      onClose?.({
        add: (entry) => rows.set(entry.id, { ...entry }),
        openCount,
      });
    },
  };

  const factory = {
    async databases() {
      if (inventoryError) throw new Error("Synthetic metadata inventory failure");
      return includeDatabase
        ? [{ name: "unrelated-database", version: 7 }, { name: "workbox-expiration", version: 1 }]
        : [{ name: "unrelated-database", version: 7 }];
    },
    open(name) {
      openCount += 1;
      openedDatabaseNames.push(name);
      if (openOutcome === "throw") throw new DOMException("Synthetic open failure", "UnknownError");
      const request = {};
      queueMicrotask(() => {
        if (openOutcome === "success") {
          request.result = db;
          request.onsuccess?.();
          return;
        }
        if (openOutcome === "upgrade") {
          request.result = db;
          request.transaction = {
            abort() {
              request.error = new DOMException("Synthetic absent database", "AbortError");
              queueMicrotask(() => request.onerror?.());
            },
          };
          request.onupgradeneeded?.();
          return;
        }
        if (openOutcome === "blocked") {
          request.onblocked?.();
          return;
        }
        request.error = new DOMException("Synthetic version failure", "VersionError");
        request.onerror?.();
      });
      return request;
    },
  };

  return {
    factory,
    openCount: () => openCount,
    count: (cacheName) => [...rows.values()].filter((entry) => entry.cacheName === cacheName).length,
    openedDatabaseNames,
    transactions,
  };
}
{
  const originalDelete = window.caches.delete;
  window.caches.delete = async () => {
    throw new DOMException("Synthetic Cache Storage failure", "SecurityError");
  };
  try {
    await assert.rejects(
      cacheReset.beginPrivateCacheReset(privateCacheNames, new Set(), true)
        .then((reset) => cacheReset.completePrivateCacheReset(reset, true, [])),
      /本地私有缓存暂不可用/,
      "Cache Storage rejection must keep cleanup incomplete",
    );
  } finally {
    window.caches.delete = originalDelete;
  }
  assert.equal(localStorage.getItem("cloudphoto_private_cleanup_v2"), null);
}

{
  const originalDelete = window.caches.delete;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const commands = [];
  const deletionFenceStates = [];
  let fenceGeneration = 0;
  let cacheWritesEnabled = false;
  let cleanupActive = false;
  const controller = {
    postMessage(message, ports) {
      commands.push(message.command);
      if (message.command === "begin") {
        fenceGeneration += 1;
        cacheWritesEnabled = false;
        cleanupActive = true;
        ports[0].postMessage({ ok: true, generation: fenceGeneration });
        return;
      }
      if (message.command === "enable") {
        if (!cleanupActive) {
          fenceGeneration += 1;
          cacheWritesEnabled = true;
        }
        ports[0].postMessage({ ok: !cleanupActive, generation: fenceGeneration });
        return;
      }
      const ok = (
        (message.command === "resume" || message.command === "complete")
        && message.generation === fenceGeneration
        && cleanupActive
      );
      if (ok) {
        cacheWritesEnabled = message.command === "resume";
        cleanupActive = false;
      }
      ports[0].postMessage({ ok, generation: fenceGeneration });
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { controller } },
  });
  window.caches.delete = async () => {
    deletionFenceStates.push(cacheWritesEnabled);
    return true;
  };
  try {
    const reset = await cacheReset.beginPrivateCacheReset(privateCacheNames, new Set(), true);
    await cacheReset.completePrivateCacheReset(reset, true, []);
    assert.deepEqual(commands, ["begin", "resume"]);
    assert(
      deletionFenceStates.every((enabled) => enabled === false),
      "private cache writes must stay fenced throughout both cleanup passes",
    );
    assert.equal(cacheWritesEnabled, true, "replacement-owner preparation may resume writes");

    commands.length = 0;
    deletionFenceStates.length = 0;
    cacheWritesEnabled = false;
    await cacheReset.enablePrivateCacheWrites();
    assert.deepEqual(commands, ["enable"]);
    assert.equal(
      cacheWritesEnabled,
      true,
      "a validated matching owner must reopen a restarted fail-closed worker",
    );

    commands.length = 0;
    const listReset = await cacheReset.beginPrivateCacheReset(
      ["cloudphoto-photo-lists-v1"],
      new Set(),
      false,
    );
    await cacheReset.completePrivateCacheReset(listReset, false, []);
    assert.deepEqual(
      commands,
      [],
      "list-only invalidation must not re-enable private media writes after logout",
    );

    const logoutReset = await cacheReset.beginPrivateCacheReset(privateCacheNames, new Set(), true);
    await cacheReset.completePrivateCacheReset(logoutReset, false, []);
    assert.deepEqual(commands, ["begin", "complete"]);
    assert.equal(cacheWritesEnabled, false, "logout cleanup must leave private SW writes fenced");

    commands.length = 0;
    let releaseDeletes;
    const deletesMayFinish = new Promise((resolve) => {
      releaseDeletes = resolve;
    });
    window.caches.delete = async () => {
      deletionFenceStates.push(cacheWritesEnabled);
      await deletesMayFinish;
      return true;
    };
    const concurrentLogout = cacheReset.beginPrivateCacheReset(privateCacheNames, new Set(), true)
      .then((reset) => cacheReset.completePrivateCacheReset(reset, false, []));
    while (!commands.includes("begin")) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await assert.rejects(
      cacheReset.enablePrivateCacheWrites(),
      /service worker fence/,
      "an authenticated handshake must not supersede an active logout cleanup",
    );
    releaseDeletes();
    await concurrentLogout;
    assert.deepEqual(commands, ["begin", "enable", "complete"]);
    assert.equal(cacheWritesEnabled, false, "logout completion must remain fail closed");

    commands.length = 0;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        serviceWorker: {
          controller: null,
          async getRegistration() {
            return { active: controller };
          },
        },
      },
    });
    await cacheReset.enablePrivateCacheWrites();
    assert.deepEqual(
      commands,
      ["enable"],
      "a controllerless tab must fence through the active registration worker",
    );
  } finally {
    window.caches.delete = originalDelete;
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      delete globalThis.navigator;
    }
  }
}
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
localStorage.setItem("cf_recent_share_links", JSON.stringify([{
  id: "legacy-share",
  photoName: "private/legacy.jpg",
  displayName: "legacy",
  url: "https://example.test/share?token=legacy-public-token",
  expiresAt: "2026-08-12T12:00:00.000Z",
  createdAt: "2026-08-10T12:00:00.000Z",
}]));
values.set("cloudphoto_private_data_v1:non-enumerable-private-record", "private");
localStorage.setItem("cloudphoto_private_cleanup_v1", "1");
for (const [key, value] of [
  ["cf_grid_size", "lg"],
  ["fab-pos", JSON.stringify({ x: 10, y: 20 })],
  ["cf_install_banner_dismissed", "1"],
  ["cf_tab_account-a", "folders"],
  ["cf_path_group-a", "private-folder"],
  ["cf_xf_group-a", JSON.stringify(["private-folder"])],
]) {
  localStorage.setItem(key, value);
}
assert.equal(await lifecycle.preparePrivatePhotoCachesForScope("account-a:viewer"), true);
assert.equal(values.has("cloudphoto_moments_insights_v1"), false, "legacy insights must be deleted, not adopted");
assert.equal(values.has("cloudphoto_moments_diagnostics_v1"), false, "legacy diagnostics must be deleted, not adopted");
assert.equal(values.has("cf_recent_share_links"), false, "legacy share links must be deleted, not adopted");
assert.equal(
  values.has("cloudphoto_private_data_v1:non-enumerable-private-record"),
  false,
  "cleanup must use the Storage key API rather than enumerable object properties",
);
assert.equal(values.has("cloudphoto_private_cleanup_v1"), false, "legacy cleanup marker must not bypass the SW fence");
assert.equal(values.get("cloudphoto_private_cleanup_v2"), "1", "fenced cleanup must write the versioned marker");
assert.deepEqual(momentsStore.readPrivateMomentInsights("personal"), {}, "unowned legacy data must stay unreadable");
assert.deepEqual(shareStore.listRecentShareLinks(), [], "unowned legacy share tokens must stay unreadable");
for (const key of [
  "cf_grid_size",
  "fab-pos",
  "cf_install_banner_dismissed",
  "cf_tab_account-a",
  "cf_path_group-a",
  "cf_xf_group-a",
]) {
  assert(values.has(key), `${key} must remain outside private-data cleanup`);
}

const shareInput = {
  photoName: "private/photo.jpg",
  displayName: "private photo",
  url: "https://example.test/share?token=account-a-public-token",
  expiresAt: "2099-08-12T12:00:00.000Z",
};
const accountAShareContext = shareStore.captureRecentShareLinksContext();
assert(accountAShareContext, "an authenticated scope must create a recent-share write context");
assert.equal(
  shareStore.addRecentShareLink(accountAShareContext, shareInput).persisted,
  true,
  "the current account may persist its own recent public share link",
);
assert.equal(shareStore.listRecentShareLinks().length, 1);

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
await listLifecycle.invalidatePhotoListCaches();
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
const boundaryContext = momentsStore.capturePrivateMomentsContext("local-calendar-group");
const boundaryTimestamp = "2026-08-10T16:30:00.000Z";
const boundaryDateKey = dateFormat.getLocalCalendarDateKey(boundaryTimestamp);
assert.equal(
  await momentsStore.recordPrivateMomentViewLocally(
    boundaryContext,
    insight.photoName,
    "viewer",
    boundaryTimestamp,
  ),
  true,
);
const boundaryStorageKey = momentsStore.privateMomentsStorageKey("insights", boundaryContext);
assert.deepEqual(
  JSON.parse(values.get(boundaryStorageKey))[insight.photoName].dailyViews,
  { [boundaryDateKey]: 1 },
  "moments daily stats must use the shared local calendar day",
);
assert.equal(
  await momentsStore.recordPrivateMomentViewLocally(
    boundaryContext,
    insight.photoName,
    "viewer",
    "not-a-date",
  ),
  false,
  "invalid moment timestamps must not create a fallback day bucket",
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
const staleShareContext = shareStore.captureRecentShareLinksContext();
const switchPromise = lifecycle.preparePrivatePhotoCachesForScope("account-b:admin");
assert.equal(resetCount, 1, "account/role switches must synchronously clear in-memory consumers");
assert.deepEqual(momentsStore.readPrivateMomentInsights("personal"), {}, "old moments must be unreadable before auth UI updates");
assert.deepEqual(shareStore.listRecentShareLinks(), [], "old share links must be unreadable before auth UI updates");
assert.equal(
  await momentsStore.writePrivateMomentInsights(staleContext, { [insight.photoName]: insight }),
  false,
  "a stale in-flight write must be rejected by owner/generation fencing",
);
assert.equal(
  shareStore.addRecentShareLink(staleShareContext, {
    ...shareInput,
    url: "https://example.test/share?token=stale-public-token",
  }).reason,
  "stale-context",
  "a stale share response must not persist after an account or role switch",
);
assert.equal(values.has("cloudphoto_moments_insights_v1"), false, "stale writes must not recreate legacy keys");
assert.equal(values.has("cf_recent_share_links"), false, "stale share writes must not recreate the legacy key");
assert(
  ![...values.values()].some((value) => value.includes("account-a-public-token") || value.includes("stale-public-token")),
  "public share tokens must not survive an account switch",
);
await switchPromise;
unregisterReset();

const accountBContext = momentsStore.capturePrivateMomentsContext("personal");
assert(accountBContext);
assert.deepEqual(shareStore.listRecentShareLinks(), [], "the next account must not see the previous account's recent links");
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

cacheDeleteFailure = listLifecycle.PHOTO_LIST_CACHE_NAME;
await assert.rejects(
  listLifecycle.invalidatePhotoListCaches(),
  /本地私有缓存暂不可用/,
  "failed list invalidation must reject explicitly",
);
await assert.rejects(
  listLifecycle.waitForPrivatePhotoListCacheCleanup(),
  /本地私有缓存暂不可用/,
  "failed current-generation invalidation must keep persistence fenced",
);
cacheDeleteFailure = null;
await listLifecycle.invalidatePhotoListCaches();
await listLifecycle.waitForPrivatePhotoListCacheCleanup();

{
  let releaseStaleDeletion;
  let reportStaleDeletionStarted;
  const staleDeletionStarted = new Promise((resolve) => {
    reportStaleDeletionStarted = resolve;
  });
  const staleDeletionBlocked = new Promise((resolve) => {
    releaseStaleDeletion = resolve;
  });
  const deletionOwners = [];
  let blockFirstListDeletion = true;
  beforeCacheDelete = async (name) => {
    deletionOwners.push({ name, owner: lifecycle.getPrivatePhotoCacheOwner() });
    if (name === listLifecycle.PHOTO_LIST_CACHE_NAME && blockFirstListDeletion) {
      blockFirstListDeletion = false;
      reportStaleDeletionStarted();
      await staleDeletionBlocked;
    }
  };

  availableCacheNames.add(listLifecycle.PHOTO_LIST_CACHE_NAME);
  const staleListCleanup = listLifecycle.invalidatePhotoListCaches();
  await staleDeletionStarted;
  assert.equal(
    await lifecycle.preparePrivatePhotoCachesForScope("account-c:viewer"),
    true,
    "a replacement account must not wait for a blocked list-only cleanup",
  );
  let persistenceBarrierReleased = false;
  const persistenceBarrier = Promise.all([
    lifecycle.waitForPrivatePhotoCacheCleanup(),
    listLifecycle.waitForPrivatePhotoListCacheCleanup(),
  ]).then(() => {
    persistenceBarrierReleased = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    persistenceBarrierReleased,
    false,
    "new persistent list access must wait for an older in-flight deletion",
  );

  releaseStaleDeletion();
  await staleListCleanup;
  await persistenceBarrier;
  assert.equal(
    deletionOwners.some(({ name, owner }) =>
      name === listLifecycle.PHOTO_LIST_CACHE_NAME && owner === "account-c:viewer"
    ),
    false,
    "generation drift must abort the stale cleanup before its second deletion pass",
  );
  beforeCacheDelete = null;
  await lifecycle.preparePrivatePhotoCachesForScope("account-b:admin");
}

const shareRaceContext = shareStore.captureRecentShareLinksContext();
const shareRaceKey = shareStore.privateShareLinksStorageKey(shareRaceContext);
afterSetItem = () => {
  void lifecycle.clearPrivatePhotoCaches();
};
assert.equal(
  shareStore.addRecentShareLink(shareRaceContext, {
    ...shareInput,
    url: "https://example.test/share?token=cross-tab-public-token",
  }).reason,
  "stale-context",
  "a cross-tab owner change during setItem must reject a share-link write",
);
assert.equal(values.has(shareRaceKey), false, "a rejected cross-tab share write must be rolled back");
await lifecycle.preparePrivatePhotoCachesForScope("account-b:admin");

const invalidShareContext = shareStore.captureRecentShareLinksContext();
const invalidShareKey = shareStore.privateShareLinksStorageKey(invalidShareContext);
localStorage.setItem(invalidShareKey, "{broken");
assert.deepEqual(shareStore.listRecentShareLinks(), [], "malformed recent-share JSON must fail closed");
assert.equal(values.has(invalidShareKey), false, "malformed recent-share JSON must be removed");
assert.equal(
  shareStore.addRecentShareLink(invalidShareContext, {
    ...shareInput,
    displayName: "x".repeat(shareStore.RECENT_SHARE_LINKS_MAX_BYTES),
  }).reason,
  "invalid-entry",
  "oversized recent-share entries must be rejected",
);

const storageSetItem = localStorage.setItem;
localStorage.setItem = function setItemWithBlockedOwner(key, value) {
  if (key === "cloudphoto_private_cache_owner_v1") {
    throw new DOMException("Storage blocked", "SecurityError");
  }
  return storageSetItem.call(this, key, value);
};
await lifecycle.preparePrivatePhotoCachesForScope("account-c:viewer");
const storageBlockedContext = shareStore.captureRecentShareLinksContext();
assert(
  shareStore.isRecentShareLinksContextCurrent(storageBlockedContext),
  "authenticated share responses must remain generation-fenced when local persistence is unavailable",
);
assert.equal(
  shareStore.addRecentShareLink(storageBlockedContext, shareInput).reason,
  "storage-unavailable",
  "blocked local persistence must not create an unowned recent-share record",
);
localStorage.setItem = storageSetItem;
await lifecycle.preparePrivatePhotoCachesForScope("account-b:admin");

const quotaContext = shareStore.captureRecentShareLinksContext();
const quotaKey = shareStore.privateShareLinksStorageKey(quotaContext);
const originalGetItem = localStorage.getItem;
const originalRemoveItem = localStorage.removeItem;
localStorage.setItem = function setItemAtQuota(key, value) {
  if (key === quotaKey) {
    throw new DOMException("Quota exceeded", "QuotaExceededError");
  }
  return storageSetItem.call(this, key, value);
};
assert.deepEqual(
  shareStore.addRecentShareLink(quotaContext, shareInput),
  { persisted: false, reason: "storage-unavailable" },
  "quota failures must be explicit without escaping after server share creation",
);
assert.deepEqual(
  shareStore.listRecentShareLinks(quotaContext),
  [],
  "quota failures must not make recent-share listing throw",
);
localStorage.setItem = storageSetItem;
assert.equal(shareStore.addRecentShareLink(quotaContext, shareInput).persisted, true);
localStorage.getItem = function getItemWithPrivacyError(key) {
  if (key === quotaKey) throw new DOMException("Storage blocked", "SecurityError");
  return originalGetItem.call(this, key);
};
assert.deepEqual(
  shareStore.listRecentShareLinks(quotaContext),
  [],
  "privacy-mode getItem failures must fail closed without crashing Settings",
);
assert.deepEqual(
  shareStore.removeRecentShareLink(quotaContext, "missing"),
  { persisted: false, reason: "storage-unavailable" },
  "remove must report an unavailable store instead of throwing",
);
localStorage.getItem = function getItemWithOwnerPrivacyError(key) {
  if (key === "cloudphoto_private_cache_owner_v1") {
    throw new DOMException("Storage blocked", "SecurityError");
  }
  return originalGetItem.call(this, key);
};
assert.deepEqual(
  shareStore.clearRecentShareLinks(quotaContext),
  { persisted: false, reason: "storage-unavailable" },
  "clear must not bypass an unavailable persisted owner marker",
);
assert(values.has(quotaKey), "a clear without a verified owner marker must not mutate scoped storage");
localStorage.getItem = originalGetItem;
localStorage.removeItem = function removeItemWithPrivacyError(key) {
  if (key === quotaKey) throw new DOMException("Storage blocked", "SecurityError");
  return originalRemoveItem.call(this, key);
};
assert.deepEqual(
  shareStore.clearRecentShareLinks(quotaContext),
  { persisted: false, reason: "storage-unavailable" },
  "clear must report an unavailable store instead of throwing",
);
localStorage.removeItem = originalRemoveItem;
localStorage.removeItem(quotaKey);

{
  const expirationDb = createFakeWorkboxExpirationDb([
    ...Array.from({ length: 350 }, (_, index) => ({
      id: `private-${index}`,
      cacheName: "photo-media-v1",
      timestamp: index,
    })),
    ...Array.from({ length: 48 }, (_, index) => ({
      id: `app-${index}`,
      cacheName: "app-code-v1",
      timestamp: index,
    })),
    { id: "legacy-private", cacheName: "cf-media-v1", timestamp: 1 },
    { id: "list-private", cacheName: "cloudphoto-photo-lists-v1", timestamp: 1 },
    { id: "unknown", cacheName: "future-public-cache-v1", timestamp: 1 },
  ], { trapSensitiveReads: true });

  const first = await workboxCleanup.purgePrivateWorkboxExpirationMetadata(
    expirationDb.factory,
    privateCacheNames,
  );
  assert.equal(first.status, "deleted");
  assert.equal(first.deletedEntries, 352);
  assert.equal(expirationDb.count("photo-media-v1"), 0);
  assert.equal(expirationDb.count("cf-media-v1"), 0);
  assert.equal(expirationDb.count("cloudphoto-photo-lists-v1"), 0);
  assert.equal(expirationDb.count("app-code-v1"), 48);
  assert.equal(expirationDb.count("future-public-cache-v1"), 1);
  assert.deepEqual(
    expirationDb.openedDatabaseNames,
    ["workbox-expiration"],
    "cleanup must never inspect or mutate unrelated IndexedDB databases",
  );
  assert.deepEqual(
    expirationDb.transactions.map(({ storeName, mode }) => ({ storeName, mode })),
    [
      { storeName: "cache-entries", mode: "readwrite" },
    ],
    "cleanup must use only one targeted Workbox cache-entries transaction and await completion",
  );

  const second = await workboxCleanup.purgePrivateWorkboxExpirationMetadata(
    expirationDb.factory,
    privateCacheNames,
  );
  assert.equal(second.status, "deleted");
  assert.equal(second.deletedEntries, 0);
  assert.equal(expirationDb.count("app-code-v1"), 48);
  assert.equal(expirationDb.count("future-public-cache-v1"), 1);

  const absentDb = createFakeWorkboxExpirationDb([], { includeDatabase: false });
  assert.equal(
    (await workboxCleanup.purgePrivateWorkboxExpirationMetadata(absentDb.factory, [])).status,
    "database-absent",
  );
  assert.equal(absentDb.openCount(), 0);

  const absentStore = createFakeWorkboxExpirationDb([], { includeStore: false });
  assert.equal(
    (await workboxCleanup.purgePrivateWorkboxExpirationMetadata(absentStore.factory, [])).status,
    "store-absent",
  );

  const upgradeDb = createFakeWorkboxExpirationDb([], { openOutcome: "upgrade" });
  assert.equal(
    (await workboxCleanup.purgePrivateWorkboxExpirationMetadata(
      upgradeDb.factory,
      privateCacheNames,
    )).status,
    "database-absent",
    "an upgrade attempt must be aborted instead of creating the Workbox database",
  );
  for (const openOutcome of ["blocked", "error", "throw"]) {
    await assert.rejects(
      workboxCleanup.purgePrivateWorkboxExpirationMetadata(
        createFakeWorkboxExpirationDb([], { openOutcome }).factory,
        privateCacheNames,
      ),
      /database open/,
      `${openOutcome} must reject explicitly`,
    );
  }
  await assert.rejects(
    workboxCleanup.purgePrivateWorkboxExpirationMetadata(
      createFakeWorkboxExpirationDb([], { includeIndex: false }).factory,
      privateCacheNames,
    ),
    /readwrite transaction/,
    "a missing cacheName index must not fall back to a full-store URL-bearing scan",
  );
  for (const readwriteOutcome of ["error", "abort"]) {
    const failingTransaction = createFakeWorkboxExpirationDb(
      [
        { id: "private", cacheName: "photo-media-v1", timestamp: 1 },
        { id: "app", cacheName: "app-code-v1", timestamp: 1 },
      ],
      { readwriteOutcome },
    );
    await assert.rejects(
      workboxCleanup.purgePrivateWorkboxExpirationMetadata(
        failingTransaction.factory,
        privateCacheNames,
      ),
      /transaction/,
      `readwrite ${readwriteOutcome} must reject explicitly`,
    );
    assert.equal(failingTransaction.count("photo-media-v1"), 1);
    assert.equal(failingTransaction.count("app-code-v1"), 1);
  }
}

availableCacheNames.add("photo-media-v1");
localStorage.setItem("cloudphoto_private_cache_owner_v1", "stale-pwa-owner:admin");
localStorage.setItem("cloudphoto_private_cleanup_v1", "1");
globalThis.indexedDB = {
  async databases() {
    throw new Error("metadata inventory unavailable");
  },
  open() {
    throw new Error("metadata database unavailable");
  },
};
await assert.rejects(
  lifecycle.clearPrivatePhotoCaches(),
  /本地私有缓存暂不可用/,
  "metadata cleanup failures must reject the lifecycle cleanup promise",
);
assert.equal(
  availableCacheNames.has("photo-media-v1"),
  false,
  "metadata cleanup failure must still follow private Cache Storage deletion",
);

const cacheFailureDb = createFakeWorkboxExpirationDb([
  { id: "private-cache-failure", cacheName: "photo-media-v1", timestamp: 1 },
]);
globalThis.indexedDB = cacheFailureDb.factory;
cacheDeleteFailure = "photo-media-v1";
await assert.rejects(
  lifecycle.clearPrivatePhotoCaches(),
  /本地私有缓存暂不可用/,
  "Cache Storage failures must reject after all targeted cleanup stages finish",
);
cacheDeleteFailure = null;
assert.equal(
  cacheFailureDb.count("photo-media-v1"),
  0,
  "Cache Storage failure must not skip targeted Workbox metadata cleanup",
);
assert.ok(
  cacheFailureDb.openCount() >= 2,
  "Cache Storage failure must not skip the second late-write cleanup pass",
);

availableCacheNames.add("photo-media-v1");
globalThis.indexedDB = {
  async databases() {
    return [{ name: "workbox-expiration", version: 1 }];
  },
  open() {
    throw new DOMException("Mobile storage is blocked", "SecurityError");
  },
};
const blockedMobilePreparation = await lifecycle.preparePrivatePhotoCachesForScope(
  "mobile-account:viewer",
);
assert.equal(
  blockedMobilePreparation,
  "degraded",
  "blocked mobile IndexedDB must degrade the private cache without blocking the session",
);
assert.match(
  window.__CF_CACHE_ERROR__.message,
  /本地私有缓存暂不可用/,
  "degraded preparation must retain the explicit cleanup failure",
);
assert.equal(lifecycleEvents.at(-1), "cf-private-cache-error");
assert.equal(
  lifecycle.getPrivatePhotoCacheOwner(),
  null,
  "a degraded session must not adopt private local cache ownership",
);
assert.equal(
  localStorage.getItem("cloudphoto_private_cleanup_v2"),
  null,
  "a degraded session must remain marked for a later cleanup retry",
);
assert.equal(
  localStorage.getItem("cloudphoto_private_cache_owner_v1"),
  null,
  "stale PWA ownership must be removed before a degraded session is published",
);
assert.equal(localStorage.getItem("cloudphoto_private_cleanup_v1"), null);
assert.equal(
  availableCacheNames.has("photo-media-v1"),
  false,
  "available Cache Storage must still be cleared when IndexedDB is blocked",
);

const completeCacheStorage = window.caches;
const partialCacheStorage = {};
window.caches = partialCacheStorage;
globalThis.caches = partialCacheStorage;
globalThis.indexedDB = createFakeWorkboxExpirationDb([]).factory;
const partialCachePreparation = await lifecycle.preparePrivatePhotoCachesForScope(
  "mobile-account:viewer",
);
assert.equal(
  partialCachePreparation,
  "degraded",
  "an iOS-style partial CacheStorage implementation must not lock out the session",
);
const partialCacheError = window.__CF_CACHE_ERROR__;
assert.match(
  String(partialCacheError),
  /本地私有缓存暂不可用/,
  "partial CacheStorage must remain an explicit incomplete cleanup",
);
assert.equal(partialCacheError.errors.length, 2);
assert.equal(lifecycle.getPrivatePhotoCacheOwner(), null);
assert.equal(localStorage.getItem("cloudphoto_private_cleanup_v2"), null);

const repeatedPartialPreparation = await lifecycle.preparePrivatePhotoCachesForScope(
  "mobile-account:viewer",
);
assert.equal(repeatedPartialPreparation, "degraded");
const repeatedPartialError = window.__CF_CACHE_ERROR__;
assert.equal(
  repeatedPartialError.errors.length,
  2,
  "repeated startup retries must not accumulate prior cleanup failures",
);

const quotaCacheStorage = {
  async delete() {
    throw new DOMException("Mobile quota blocked cleanup", "QuotaExceededError");
  },
};
window.caches = quotaCacheStorage;
globalThis.caches = quotaCacheStorage;
const quotaPreparation = await lifecycle.preparePrivatePhotoCachesForScope(
  "mobile-account:viewer",
);
assert.equal(quotaPreparation, "degraded");
const quotaError = window.__CF_CACHE_ERROR__;
assert.equal(
  quotaError.errors.length,
  privateCacheNames.length * 2,
  "quota failures must stay bounded to the two targeted deletion passes",
);
assert(
  quotaError.errors.every((error) =>
    error.name.includes("Cache Storage deletion")
  ),
  "each quota failure must identify its explicit cleanup step",
);

const hangingCacheStorage = {
  delete() {
    return new Promise(() => {});
  },
};
window.caches = hangingCacheStorage;
globalThis.caches = hangingCacheStorage;
const hangingPreparation = await Promise.race([
  lifecycle.preparePrivatePhotoCachesForScope("mobile-account:viewer"),
  new Promise((resolve) => setTimeout(() => resolve("login-still-blocked"), 2_500)),
]);
assert.equal(
  hangingPreparation,
  "degraded",
  "a non-settling mobile CacheStorage operation must not block authenticated online access",
);
assert.equal(lifecycle.getPrivatePhotoCacheOwner(), null);
assert.equal(localStorage.getItem("cloudphoto_private_cleanup_v2"), null);
assert.equal(localStorage.getItem("cloudphoto_private_cache_owner_v1"), null);

window.caches = completeCacheStorage;
globalThis.caches = completeCacheStorage;
globalThis.indexedDB = createFakeWorkboxExpirationDb([]).factory;
await listLifecycle.invalidatePhotoListCaches();
assert.equal(
  localStorage.getItem("cloudphoto_private_cleanup_v2"),
  null,
  "list-only invalidation must not mark a failed full private cleanup complete",
);
await assert.rejects(
  lifecycle.waitForPrivatePhotoCacheCleanup(),
  /本地私有缓存暂不可用/,
  "list-only invalidation must not release the degraded persistence barrier",
);
assert.equal(
  await lifecycle.preparePrivatePhotoCachesForScope("mobile-account:viewer"),
  true,
  "a later startup/session retry must recover after transient mobile storage failures",
);
assert.equal(lifecycle.getPrivatePhotoCacheOwner(), "mobile-account:viewer");
assert.equal(localStorage.getItem("cloudphoto_private_cleanup_v2"), "1");
await listLifecycle.invalidatePhotoListCaches();
assert.equal(
  localStorage.getItem("cloudphoto_private_cleanup_v2"),
  "1",
  "list-only invalidation must preserve an already-successful full cleanup marker",
);

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    serviceWorker: {
      controller: {
        postMessage(_message, ports) {
          ports[0].postMessage({ ok: false, generation: 0 });
        },
      },
    },
  },
});
assert.equal(
  await lifecycle.preparePrivatePhotoCachesForScope("mobile-account:viewer"),
  "degraded",
  "a matching owner must degrade rather than retain ownership when SW enable fails",
);
assert.equal(lifecycle.getPrivatePhotoCacheOwner(), null);
assert.equal(localStorage.getItem("cloudphoto_private_cache_owner_v1"), null);
assert.equal(localStorage.getItem("cloudphoto_private_cleanup_v2"), null);
await assert.rejects(
  lifecycle.waitForPrivatePhotoCacheCleanup(),
  /service worker fence/,
  "SW enable failure must keep persistent private data behind the degraded barrier",
);
if (originalNavigator) {
  Object.defineProperty(globalThis, "navigator", originalNavigator);
} else {
  delete globalThis.navigator;
}

{
  const delayedTimerReset = cacheReset.resetPrivateCaches(
    privateCacheNames,
    new Set(),
    false,
    false,
  );
  const blockedUntil = Date.now() + 2_100;
  while (Date.now() < blockedUntil) {
    // Delay timer dispatch while promise continuations remain queued.
  }
  await assert.rejects(
    delayedTimerReset,
    /deadline/,
    "wall-clock expiry must win even when the timer callback is delayed",
  );
}

{
  let resolveRegistration;
  const lateFenceCommands = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: {
        controller: null,
        getRegistration() {
          return new Promise((resolve) => {
            resolveRegistration = resolve;
          });
        },
      },
    },
  });
  await assert.rejects(
    cacheReset.resetPrivateCaches(privateCacheNames, new Set(), true, true),
    /deadline/,
    "a stalled registration lookup must reach the cleanup deadline",
  );
  resolveRegistration({
    active: {
      postMessage(message) {
        lateFenceCommands.push(message.command);
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    lateFenceCommands,
    [],
    "a registration lookup that settles after the deadline must not send a stale begin command",
  );
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  } else {
    delete globalThis.navigator;
  }
}

assert.equal(
  await lifecycle.preparePrivatePhotoCachesForScope("mobile-account:viewer"),
  true,
  "a later full cleanup must recover the SW-enable degradation",
);

let recreatedLateEntry = false;
const lifecycleExpirationDb = createFakeWorkboxExpirationDb(
  [
    ...Array.from({ length: 350 }, (_, index) => ({
      id: `lifecycle-private-${index}`,
      cacheName: "photo-media-v1",
      timestamp: index,
    })),
    ...Array.from({ length: 48 }, (_, index) => ({
      id: `lifecycle-app-${index}`,
      cacheName: "app-code-v1",
      timestamp: index,
    })),
  ],
  {
    onClose({ add }) {
      if (recreatedLateEntry) return;
      recreatedLateEntry = true;
      add({ id: "late-private", cacheName: "photo-media-v1", timestamp: 999 });
      availableCacheNames.add("photo-media-v1");
    },
  },
);
globalThis.indexedDB = lifecycleExpirationDb.factory;
await lifecycle.clearPrivatePhotoCaches();
assert.deepEqual(momentsStore.readPrivateMomentInsights("personal"), {}, "logout/401 must delete scoped moments");
assert.deepEqual(shareStore.listRecentShareLinks(), [], "logout/401 must delete scoped recent share links");
assert.equal(
  availableCacheNames.has("photo-media-v1"),
  false,
  "logout must delete private media recreated while the purge chunk runs",
);
assert.equal(availableCacheNames.has("workbox-precache-v2"), true, "logout must preserve the private app shell");
assert.equal(lifecycleExpirationDb.count("photo-media-v1"), 0, "logout must remove private expiration metadata");
assert.equal(lifecycleExpirationDb.count("app-code-v1"), 48, "logout must preserve app-code expiration metadata");
assert.ok(lifecycleExpirationDb.openCount() >= 2, "logout must repeat targeted cleanup after active writes");
delete globalThis.indexedDB;
for (const key of [
  "cf_grid_size",
  "fab-pos",
  "cf_install_banner_dismissed",
  "cf_tab_account-a",
  "cf_path_group-a",
  "cf_xf_group-a",
]) {
  assert(values.has(key), `${key} must survive logout private-data cleanup`);
}

const auth = await read("packages/client/src/contexts/AuthContext.tsx");
const app = await read("packages/client/src/AuthenticatedApp.tsx");
const logoutStart = auth.indexOf("const logout = useCallback");
const logoutBody = auth.slice(logoutStart, auth.indexOf("useEffect", logoutStart));
assert(
  logoutBody.indexOf("await clearPrivatePhotoCaches()") < logoutBody.indexOf("setUser(null)"),
  "explicit logout and 401 logout must await private-data cleanup before clearing auth state",
);
assert(
  auth.includes("setUnauthorizedHandler(async (failedToken) => {")
  && auth.includes("if (!failedToken || getToken() === failedToken) await logout();"),
  "the active-token 401 path must use the same private-data logout boundary",
);
const crossTabStart = auth.indexOf("const handleStorage");
assert(crossTabStart >= 0);
const crossTabBody = auth.slice(crossTabStart, auth.indexOf("window.addEventListener", crossTabStart));
assert(
  crossTabBody.indexOf("await clearPrivatePhotoCaches()") < crossTabBody.indexOf("setUser(null)"),
  "cross-tab account replacement must await private data cleanup before clearing auth state",
);
assert(
  crossTabBody.includes("if (!getToken()) {")
  && !crossTabBody.includes("if (event.newValue === null)"),
  "cross-tab cleanup must adopt the current token when another tab replaces it during cleanup",
);
assert(
  auth.includes("if (!getToken()) {")
  && auth.includes("await clearPrivatePhotoCaches();"),
  "invalid or absent token restore must fail closed and remove orphaned private data",
);
assert(
  !auth.includes("void clearPrivatePhotoCaches()"),
  "privacy-critical auth paths must never discard the cleanup promise",
);
assert(
  auth.includes("getTokenAuthScope() !== nextScope")
  && auth.includes("preparePrivatePhotoCachesForScope(nextScope)")
  && (auth.match(/restoreCurrentUser\(controller, generation\)/g) ?? []).length === 2,
  "restored sessions must validate and prepare the exact account/role scope before publishing the user",
);
assert(
  auth.includes("await preparePrivatePhotoCachesForScope(nextScope) === false")
  && auth.includes("await preparePrivatePhotoCachesForScope(nextScope) !== false"),
  "login and cross-tab replacement must publish a fenced degraded session but reject stale auth",
);
assert(
  lifecycleSource.includes("__CF_CACHE_ERROR__")
  && app.includes("Cache preparation deferred:")
  && app.includes("在线内容可继续使用，下次打开时将重试"),
  "degraded cleanup must remain explicit through the existing error and toast channels",
);
assert(
  auth.includes("replacementScope && replacementScope === currentScope"),
  "same-account cross-tab token rotation may preserve its own scope",
);

const gallery = await read("packages/client/src/components/gallery/PhotoGallery.tsx");
const folderView = await read("packages/client/src/components/gallery/FolderView.tsx");
const clipboard = await read("packages/client/src/services/share/clipboard.ts");
const http = await read("packages/client/src/services/http.ts");
const settings = await read("packages/client/src/components/settings/SettingsDialog.tsx");
for (const [label, source] of [["gallery", gallery], ["home", app], ["settings", settings]]) {
  assert(!source.includes('"cloudphoto_moments_insights_v1"'), `${label} must not read the global legacy insights key`);
  assert(!source.includes('"cloudphoto_moments_diagnostics_v1"'), `${label} must not read the global legacy diagnostics key`);
}
assert(gallery.includes("registerPrivatePhotoCacheReset"), "PhotoGallery must clear moments state on lifecycle reset");
assert(gallery.includes("await localWrite;"), "server reconciliation must wait for its matching local delta");
assert(app.includes("readPrivateMomentsDiagnostics"), "home diagnostics must use the scoped helper");
assert(settings.includes("readPrivateMomentsDiagnostics"), "Settings diagnostics must use the scoped helper");
assert(!settings.includes('"cf_recent_share_links"'), "Settings must not read the global legacy share-link key");
assert(settings.includes("registerPrivateLocalDataReset"), "Settings must clear local share state on cross-tab auth reset");
for (const [label, source] of [["gallery", gallery], ["folder", folderView]]) {
  const captureIndex = source.indexOf("captureRecentShareLinksContext()");
  const createIndex = source.indexOf("await createPhotoShareLink", captureIndex);
  assert(captureIndex >= 0 && createIndex > captureIndex, `${label} must fence share writes before awaiting the server`);
  const responseFenceIndex = source.indexOf("isRecentShareLinksContextCurrent(shareContext)", createIndex);
  const copyIndex = source.indexOf("await copyText", createIndex);
  const postCopyFenceIndex = source.indexOf("isRecentShareLinksContextCurrent(shareContext)", responseFenceIndex + 1);
  assert(
    responseFenceIndex > createIndex
    && copyIndex > responseFenceIndex
    && postCopyFenceIndex > copyIndex,
    `${label} must reject stale share responses before and after asynchronous clipboard access`,
  );
  assert(source.includes("addRecentShareLink(shareContext,"), `${label} must write through its captured private-data context`);
  assert(
    source.includes('persistence.reason === "stale-context"')
    && source.includes("未保存到最近记录"),
    `${label} must keep a created link usable while distinguishing stale auth from local persistence failure`,
  );
}
assert.equal(
  gallery.match(/await createPhotoShareLink/g)?.length,
  1,
  "PhotoGallery must issue exactly one non-idempotent create request per share action",
);
assert.equal(
  folderView.match(/await createPhotoShareLink/g)?.length,
  1,
  "FolderView must issue exactly one non-idempotent photo-share create request per action",
);
assert.equal(
  folderView.match(/await createFolderShareLink/g)?.length,
  1,
  "FolderView must issue exactly one non-idempotent folder-share create request per action",
);
const unauthorizedRetry = http.slice(http.indexOf("export function fetchWithTimeout"));
assert.equal(
  unauthorizedRetry.match(/canReplayRequest\(input, init\)/g)?.length,
  2,
  "both 401 recovery branches must use the endpoint-aware replay guard",
);
assert(
  http.includes('request.suffix !== "/photos/share"'),
  "share creation must be excluded from route and auth replay despite using GET",
);
assert(
  http.includes("canReplayRequest(primaryInput, init)")
    && http.includes("&& !isLoginRequest(primaryInput, init)"),
  "same-origin route recovery must not bypass the endpoint-aware share replay guard",
);
assert(
  folderView.includes("`cf_path_${contextKey}`") && folderView.includes("`cf_xf_${contextKey}`"),
  "folder path and empty-folder keys must retain their existing workspace context",
);
assert(
  clipboard.includes("return canCopy() ? legacyCopy(text) : false"),
  "legacy clipboard fallback must revalidate the private-data generation",
);
assert(
  settings.includes("copyShareLink(item.url, shareLinksContext)")
  && settings.includes("isRecentShareLinksContextCurrent(shareLinksContext)")
  && settings.includes("removeRecentShareLink(shareLinksContext, item.id)")
  && settings.includes("clearRecentShareLinks(shareLinksContext)"),
  "every Settings action on a local share must stay bound to the context that rendered it",
);
assert(
  settings.includes("无法删除本地分享记录")
  && settings.includes("无法清空本地分享记录"),
  "Settings must surface storage failures without crashing or claiming success",
);

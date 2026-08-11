const CACHE_OWNER_KEY = "cloudphoto_private_cache_owner_v1";
const PRIVATE_CLEANUP_MARKER_KEY = "cloudphoto_private_cleanup_v2";
const PRIVATE_CACHE_FENCE_MESSAGE = "cloudphoto-private-cache-fence";
const LEGACY_PRIVATE_LOCAL_KEYS = [
  "cloudphoto_moments_insights_v1",
  "cloudphoto_moments_diagnostics_v1",
  "cf_recent_share_links",
  "cloudphoto_private_cleanup_v1",
] as const;

type PrivateCacheFence = {
  controller: ServiceWorker;
  generation: number;
};

export type PrivateCacheReset = {
  fence: PrivateCacheFence | null;
  failures: unknown[];
};

function cleanupFailure(step: string, cause: unknown): Error {
  return new Error(`Private cache cleanup failed during ${step}`, { cause });
}

export function removeLegacyPrivateLocalData(): void {
  try {
    for (const key of LEGACY_PRIVATE_LOCAL_KEYS) localStorage.removeItem(key);
  } catch {
    // Cache Storage cleanup and in-memory invalidation still proceed.
  }
}

export function storePrivateCacheOwner(authScope: string): void {
  try {
    localStorage.setItem(CACHE_OWNER_KEY, authScope);
  } catch {
    // Authorization-scoped cache keys still isolate memory and Cache Storage entries.
  }
}

function sendPrivateCacheFenceMessage(
  controller: ServiceWorker,
  command: "begin" | "resume" | "complete" | "enable",
  generation?: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = globalThis.setTimeout(() => {
      channel.port1.close();
      reject(cleanupFailure("service worker fence", new Error("response timed out")));
    }, 1_000);
    channel.port1.onmessage = ({ data }) => {
      globalThis.clearTimeout(timeout);
      channel.port1.close();
      if (data?.ok === true && Number.isSafeInteger(data.generation)) {
        resolve(data.generation);
      } else {
        reject(cleanupFailure("service worker fence", new Error("request rejected")));
      }
    };
    try {
      controller.postMessage(
        { type: PRIVATE_CACHE_FENCE_MESSAGE, command, generation },
        [channel.port2],
      );
    } catch (error) {
      globalThis.clearTimeout(timeout);
      channel.port1.close();
      reject(cleanupFailure("service worker fence", error));
    }
  });
}

async function getPrivateCacheServiceWorker(): Promise<ServiceWorker | null> {
  if (
    typeof navigator === "undefined"
    || !("serviceWorker" in navigator)
  ) {
    return null;
  }
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration?.active ?? null;
}

async function beginPrivateCacheFence(): Promise<PrivateCacheFence | null> {
  const controller = await getPrivateCacheServiceWorker();
  if (!controller) return null;
  return {
    controller,
    generation: await sendPrivateCacheFenceMessage(controller, "begin"),
  };
}

export async function enablePrivateCacheWrites(): Promise<void> {
  const controller = await getPrivateCacheServiceWorker();
  if (!controller) return;
  await sendPrivateCacheFenceMessage(controller, "enable");
}

export async function beginPrivateCacheReset(
  cacheNames: readonly string[],
  activePersistentWrites: ReadonlySet<Promise<void>>,
  fencePrivateMediaWrites: boolean,
): Promise<PrivateCacheReset> {
  removeLegacyPrivateLocalData();
  if (fencePrivateMediaWrites) {
    try {
      localStorage.removeItem(PRIVATE_CLEANUP_MARKER_KEY);
    } catch {
      // In-memory ownership still gates private writes when storage is unavailable.
    }
  }

  const reset: PrivateCacheReset = { fence: null, failures: [] };
  if (fencePrivateMediaWrites) {
    try {
      reset.fence = await beginPrivateCacheFence();
    } catch (error) {
      reset.failures.push(error);
    }
  }
  await deletePrivateCacheStorage(reset, cacheNames, activePersistentWrites);
  return reset;
}

async function deletePrivateCacheStorage(
  reset: PrivateCacheReset,
  cacheNames: readonly string[],
  activePersistentWrites: ReadonlySet<Promise<void>>,
): Promise<void> {
  await Promise.allSettled([...activePersistentWrites]);
  let cacheStorage: CacheStorage | undefined;
  try {
    cacheStorage = globalThis.caches;
  } catch (error) {
    reset.failures.push(cleanupFailure("Cache Storage access", error));
    return;
  }
  if (!cacheStorage) return;
  if (typeof cacheStorage.delete !== "function") {
    reset.failures.push(cleanupFailure(
      "Cache Storage deletion",
      new TypeError("CacheStorage.delete is unavailable"),
    ));
    return;
  }
  const results = await Promise.allSettled(
    cacheNames.map(async (name) => cacheStorage.delete(name)),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      reset.failures.push(cleanupFailure(
        `Cache Storage deletion (${cacheNames[index]})`,
        result.reason,
      ));
    }
  }
}

export async function completePrivateCacheReset(
  reset: PrivateCacheReset,
  resumeCaching: boolean,
  additionalFailures: readonly unknown[],
  markCleanupComplete = true,
): Promise<void> {
  const failures = [...reset.failures, ...additionalFailures];
  if (failures.length === 0 && reset.fence) {
    try {
      await sendPrivateCacheFenceMessage(
        reset.fence.controller,
        resumeCaching ? "resume" : "complete",
        reset.fence.generation,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 0) {
    if (markCleanupComplete) {
      try {
        localStorage.setItem(PRIVATE_CLEANUP_MARKER_KEY, "1");
      } catch {
        // The caller still receives the in-memory completion result.
      }
    }
    return;
  }
  throw new AggregateError(failures, "Private cache cleanup failed");
}

export async function resetPrivateCaches(
  cacheNames: readonly string[],
  activePersistentWrites: ReadonlySet<Promise<void>>,
  fencePrivateMediaWrites: boolean,
  resumeCaching: boolean,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const reset = await beginPrivateCacheReset(
    cacheNames,
    activePersistentWrites,
    fencePrivateMediaWrites,
  );
  if (!isCurrent()) return;
  const failures: unknown[] = [];
  try {
    const cleanup = await import("./privateCachePurge.ts");
    for (let pass = 0; pass < 2; pass += 1) {
      if (!isCurrent()) return;
      await cleanup.purgePrivateWorkboxExpirationMetadata(
        typeof indexedDB === "undefined" ? undefined : indexedDB,
        cacheNames,
      );
      if (!isCurrent()) return;
    }
  } catch (error) {
    failures.push(error);
  }
  if (!isCurrent()) return;
  await deletePrivateCacheStorage(reset, cacheNames, activePersistentWrites);
  if (!isCurrent()) return;
  await completePrivateCacheReset(
    reset,
    resumeCaching,
    failures,
    fencePrivateMediaWrites,
  );
}

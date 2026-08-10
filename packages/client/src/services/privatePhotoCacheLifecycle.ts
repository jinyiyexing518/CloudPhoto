export const PHOTO_LIST_CACHE_NAME = "cloudphoto-photo-lists-v1";

const PRIVATE_MEDIA_CACHE_NAMES = ["photo-media-v1", "cf-media-v1"] as const;
const PRIVATE_CACHE_NAMES = [PHOTO_LIST_CACHE_NAME, ...PRIVATE_MEDIA_CACHE_NAMES] as const;
const CACHE_OWNER_KEY = "cloudphoto_private_cache_owner_v1";
const PRIVATE_LOCAL_DATA_PREFIX = "cloudphoto_private_data_v1:";

let cacheGeneration = 0;
let activePrivateCacheOwner: string | null = null;
let cleanupChain: Promise<void> = Promise.resolve();
const activePersistentWrites = new Set<Promise<void>>();
const resetListeners = new Set<(scopeReset: boolean) => void>();

export function getPrivatePhotoCacheGeneration(): number {
  return cacheGeneration;
}

export function getPrivatePhotoCacheOwner(): string | null {
  return activePrivateCacheOwner;
}

export function waitForPrivatePhotoCacheCleanup(): Promise<void> {
  return cleanupChain;
}

export function registerPrivatePhotoCacheReset(
  listener: (scopeReset: boolean) => void,
): () => void {
  resetListeners.add(listener);
  return () => resetListeners.delete(listener);
}

export function registerPrivatePhotoCacheWrite(operation: Promise<void>): () => void {
  activePersistentWrites.add(operation);
  return () => activePersistentWrites.delete(operation);
}

function removeScopedPrivateLocalData(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key === CACHE_OWNER_KEY || key.startsWith(PRIVATE_LOCAL_DATA_PREFIX)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // In-memory invalidation still makes scoped records unreadable.
  }
}

function queueCacheDeletion(cacheNames: readonly string[], clearOwner: boolean): Promise<void> {
  cacheGeneration += 1;
  if (clearOwner) activePrivateCacheOwner = null;
  for (const reset of resetListeners) reset(clearOwner);
  if (clearOwner) removeScopedPrivateLocalData();

  const deletePrivateCaches = async () => {
    await Promise.allSettled([...activePersistentWrites]);
    if (typeof caches !== "undefined") {
      await Promise.allSettled(cacheNames.map((name) => caches.delete(name)));
    }
    try {
      const metadata = await import("./idb.ts");
      await metadata.clean(cacheNames);
    } catch {
      console.warn("IDB purge fail");
    }
  };
  cleanupChain = cleanupChain.then(deletePrivateCaches, deletePrivateCaches);
  return cleanupChain;
}

export function invalidatePhotoListCaches(): Promise<void> {
  return queueCacheDeletion([PHOTO_LIST_CACHE_NAME], false);
}

/**
 * Clears only authenticated photo data. App-shell and Workbox precache entries
 * remain intact, so logout does not force a full application redownload.
 */
export function clearPrivatePhotoCaches(): Promise<void> {
  return queueCacheDeletion(PRIVATE_CACHE_NAMES, true);
}

/**
 * Adopts private caches for one authorization scope (`userId:role`). Unknown
 * legacy ownership, account switches, and role changes delete private data.
 */
export async function preparePrivatePhotoCachesForScope(authScope: string): Promise<void> {
  if (typeof window === "undefined" || !authScope) return;
  let owner: string | null = null;
  let cleanupComplete = false;
  try {
    owner = localStorage.getItem(CACHE_OWNER_KEY);
    cleanupComplete = localStorage.getItem("cloudphoto_private_cleanup_v1") === "1";
  } catch {
    // Treat storage failures as unknown ownership.
  }
  const pendingCleanup = owner !== authScope || !cleanupComplete
    ? clearPrivatePhotoCaches()
    : cleanupChain;
  const expectedGeneration = cacheGeneration;
  await pendingCleanup;
  if (expectedGeneration !== cacheGeneration) return;
  activePrivateCacheOwner = authScope;
  try {
    localStorage.setItem(CACHE_OWNER_KEY, authScope);
  } catch {
    // Authorization-scoped cache keys still isolate memory and Cache Storage entries.
  }
}

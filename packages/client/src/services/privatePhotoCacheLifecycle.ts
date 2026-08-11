export const PHOTO_LIST_CACHE_NAME = "cloudphoto-photo-lists-v1";

const PRIVATE_MEDIA_CACHE_NAMES = ["photo-media-v1", "cf-media-v1"] as const;
const PRIVATE_CACHE_NAMES = [PHOTO_LIST_CACHE_NAME, ...PRIVATE_MEDIA_CACHE_NAMES] as const;
const CACHE_OWNER_KEY = "cloudphoto_private_cache_owner_v1";
const PRIVATE_LOCAL_DATA_PREFIX = "cloudphoto_private_data_v1:";
const PRIVATE_CLEANUP_MARKER_KEY = "cloudphoto_private_cleanup_v2";

let cacheGeneration = 0;
let activePrivateCacheOwner: string | null = null;
let cleanupChain: Promise<void> = Promise.resolve();
const activePersistentWrites = new Set<Promise<void>>();
const resetListeners = new Set<(scopeReset: boolean) => void>();
const loadPrivateCacheReset = () => import("./privateCacheReset.ts");

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
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key) keys.push(key);
    }
    for (const key of keys) {
      if (
        key === CACHE_OWNER_KEY
        || key === PRIVATE_CLEANUP_MARKER_KEY
        || key.startsWith(PRIVATE_LOCAL_DATA_PREFIX)
      ) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // In-memory invalidation still makes scoped records unreadable.
  }
}

function queueCacheDeletion(
  cacheNames: readonly string[],
  clearOwner: boolean,
  resumeCaching = !clearOwner,
  fencePrivateMediaWrites = true,
): Promise<void> {
  cacheGeneration += 1;
  if (clearOwner) activePrivateCacheOwner = null;
  for (const reset of resetListeners) reset(clearOwner);
  if (clearOwner) removeScopedPrivateLocalData();

  const deletePrivateCaches = async () => {
    const reset = await loadPrivateCacheReset();
    await reset.resetPrivateCaches(
      cacheNames,
      activePersistentWrites,
      fencePrivateMediaWrites,
      resumeCaching,
    );
  };
  cleanupChain = cleanupChain.then(deletePrivateCaches, deletePrivateCaches);
  return cleanupChain;
}

export function invalidatePhotoListCaches(): Promise<void> {
  return queueCacheDeletion([PHOTO_LIST_CACHE_NAME], false, false, false);
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
export async function preparePrivatePhotoCachesForScope(authScope: string): Promise<boolean> {
  if (typeof window === "undefined" || !authScope) return false;
  let owner: string | null = null;
  let cleanupComplete = false;
  try {
    owner = localStorage.getItem(CACHE_OWNER_KEY);
    cleanupComplete = localStorage.getItem(PRIVATE_CLEANUP_MARKER_KEY) === "1";
  } catch {
    // Treat storage failures as unknown ownership.
  }
  const pendingCleanup = owner !== authScope || !cleanupComplete
    ? queueCacheDeletion(PRIVATE_CACHE_NAMES, true, true)
    : cleanupChain;
  const expectedGeneration = cacheGeneration;
  const reset = await loadPrivateCacheReset();
  reset.removeLegacyPrivateLocalData();
  await pendingCleanup;
  if (expectedGeneration !== cacheGeneration) return false;
  if (owner === authScope && cleanupComplete) {
    await reset.enablePrivateCacheWrites();
    if (expectedGeneration !== cacheGeneration) return false;
  }
  activePrivateCacheOwner = authScope;
  reset.storePrivateCacheOwner(authScope);
  return true;
}

export const PHOTO_LIST_CACHE_NAME = "cloudphoto-photo-lists-v1";

const PRIVATE_MEDIA_CACHE_NAMES = ["photo-media-v1", "cf-media-v1"] as const;
const CACHE_OWNER_KEY = "cloudphoto_private_cache_owner_v1";
const PRIVATE_LOCAL_DATA_PREFIX = "cloudphoto_private_data_v1:";
const LEGACY_PRIVATE_LOCAL_KEYS = [
  "cloudphoto_moments_insights_v1",
  "cloudphoto_moments_diagnostics_v1",
] as const;

let cacheGeneration = 0;
let cleanupChain: Promise<void> = Promise.resolve();
const activePersistentWrites = new Set<Promise<void>>();
const resetListeners = new Set<(scopeReset: boolean) => void>();

export function getPrivatePhotoCacheGeneration(): number {
  return cacheGeneration;
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

function removePrivateLocalData(clearOwner: boolean): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (
        LEGACY_PRIVATE_LOCAL_KEYS.includes(key as typeof LEGACY_PRIVATE_LOCAL_KEYS[number])
        || (clearOwner && (key === CACHE_OWNER_KEY || key.startsWith(PRIVATE_LOCAL_DATA_PREFIX)))
      ) {
        localStorage.removeItem(key);
      }
    }
    localStorage.setItem("cloudphoto_private_cleanup_v1", "1");
  } catch {
    // Cache Storage cleanup and in-memory invalidation still proceed.
  }
}

function queueCacheDeletion(cacheNames: readonly string[], clearOwner: boolean): Promise<void> {
  cacheGeneration += 1;
  for (const reset of resetListeners) reset(clearOwner);
  if (clearOwner) removePrivateLocalData(true);

  const deletePrivateCaches = async () => {
    await Promise.allSettled([...activePersistentWrites]);
    if (typeof window === "undefined" || !("caches" in window)) return;
    await Promise.all(cacheNames.map((name) => window.caches.delete(name)));
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
  return queueCacheDeletion(
    [PHOTO_LIST_CACHE_NAME, ...PRIVATE_MEDIA_CACHE_NAMES],
    true,
  );
}

/**
 * Adopts private caches for one authorization scope (`userId:role`). Unknown
 * legacy ownership, account switches, and role changes delete private data.
 */
export async function preparePrivatePhotoCachesForScope(authScope: string): Promise<void> {
  if (typeof window === "undefined" || !authScope) return;
  let owner: string | null = null;
  try {
    owner = localStorage.getItem(CACHE_OWNER_KEY);
  } catch {
    // Treat storage failures as unknown ownership.
  }
  removePrivateLocalData(false);
  const pendingCleanup = owner !== authScope
    ? clearPrivatePhotoCaches()
    : cleanupChain;
  const expectedGeneration = cacheGeneration;
  await pendingCleanup;
  if (expectedGeneration !== cacheGeneration) return;
  try {
    localStorage.setItem(CACHE_OWNER_KEY, authScope);
  } catch {
    // Authorization-scoped cache keys still isolate memory and Cache Storage entries.
  }
}

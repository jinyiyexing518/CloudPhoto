export const PHOTO_LIST_CACHE_NAME = "cloudphoto-photo-lists-v1";

const PRIVATE_MEDIA_CACHE_NAMES = ["photo-media-v1", "cf-media-v1"] as const;
const CACHE_OWNER_KEY = "cloudphoto_private_cache_owner_v1";

let cacheGeneration = 0;
let cleanupChain: Promise<void> = Promise.resolve();
const activePersistentWrites = new Set<Promise<void>>();
const resetListeners = new Set<() => void>();

export function getPrivatePhotoCacheGeneration(): number {
  return cacheGeneration;
}

export function waitForPrivatePhotoCacheCleanup(): Promise<void> {
  return cleanupChain;
}

export function registerPrivatePhotoCacheReset(listener: () => void): () => void {
  resetListeners.add(listener);
  return () => resetListeners.delete(listener);
}

export function registerPrivatePhotoCacheWrite(operation: Promise<void>): () => void {
  activePersistentWrites.add(operation);
  return () => activePersistentWrites.delete(operation);
}

function queueCacheDeletion(cacheNames: readonly string[], clearOwner: boolean): Promise<void> {
  cacheGeneration += 1;
  for (const reset of resetListeners) reset();
  if (clearOwner && typeof window !== "undefined") {
    try {
      localStorage.removeItem(CACHE_OWNER_KEY);
    } catch {
      // Cache deletion still proceeds when localStorage is unavailable.
    }
  }

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
  if (owner !== authScope) await clearPrivatePhotoCaches();
  await cleanupChain;
  try {
    localStorage.setItem(CACHE_OWNER_KEY, authScope);
  } catch {
    // Authorization-scoped cache keys still isolate memory and Cache Storage entries.
  }
}

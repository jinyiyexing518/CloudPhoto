const PHOTO_LIST_CACHE_NAME = "cloudphoto-photo-lists-v1";
const PRIVATE_MEDIA_CACHE_NAMES = ["photo-media-v1", "cf-media-v1"] as const;
const CACHE_OWNER_KEY = "cloudphoto_private_cache_owner_v1";
const CACHE_PATH = "/__cloudphoto-cache__/photo-lists/";
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 24;
const CACHED_AT_HEADER = "x-cloudphoto-cached-at";

interface MemoryEntry {
  cachedAt: number;
  value: unknown[];
}

const memoryPhotoLists = new Map<string, MemoryEntry>();
let cleanupChain: Promise<void> = Promise.resolve();
let cacheGeneration = 0;
const activePersistentWrites = new Set<Promise<void>>();
const persistentWriteChains = new Map<string, Promise<void>>();

function cacheUrl(key: string): string | null {
  if (typeof window === "undefined" || !("caches" in window)) return null;
  return new URL(`${CACHE_PATH}${encodeURIComponent(key)}`, window.location.origin).toString();
}

function isFresh(cachedAt: number): boolean {
  return Number.isFinite(cachedAt) && Date.now() - cachedAt <= CACHE_MAX_AGE_MS;
}

function trimMemoryCache(): void {
  for (const [key, entry] of memoryPhotoLists) {
    if (!isFresh(entry.cachedAt)) memoryPhotoLists.delete(key);
  }
  while (memoryPhotoLists.size > CACHE_MAX_ENTRIES) {
    const oldest = memoryPhotoLists.keys().next().value as string | undefined;
    if (!oldest) break;
    memoryPhotoLists.delete(oldest);
  }
}

export function readMemoryPhotoListCache<T>(key: string): T[] | null {
  trimMemoryCache();
  const entry = memoryPhotoLists.get(key);
  if (!entry) return null;
  memoryPhotoLists.delete(key);
  memoryPhotoLists.set(key, entry);
  return entry.value as T[];
}

export function writeMemoryPhotoListCache<T>(key: string, value: T[]): void {
  memoryPhotoLists.delete(key);
  if (value.length > 0) {
    memoryPhotoLists.set(key, { cachedAt: Date.now(), value });
  }
  trimMemoryCache();
}

export function getPrivatePhotoCacheGeneration(): number {
  return cacheGeneration;
}

async function prunePersistentCache(cache: Cache): Promise<void> {
  const fresh: Array<{ request: Request; cachedAt: number }> = [];
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    const cachedAt = Number(response?.headers.get(CACHED_AT_HEADER));
    if (!response || !isFresh(cachedAt)) {
      await cache.delete(request);
    } else {
      fresh.push({ request, cachedAt });
    }
  }
  fresh.sort((a, b) => b.cachedAt - a.cachedAt);
  await Promise.all(
    fresh.slice(CACHE_MAX_ENTRIES).map(({ request }) => cache.delete(request)),
  );
}

export async function readPhotoListCache<T>(
  key: string,
  expectedGeneration = cacheGeneration,
): Promise<T[] | null> {
  const url = cacheUrl(key);
  if (!url) return null;

  try {
    await cleanupChain;
    if (expectedGeneration !== cacheGeneration) return null;
    const cache = await window.caches.open(PHOTO_LIST_CACHE_NAME);
    if (expectedGeneration !== cacheGeneration) return null;
    await prunePersistentCache(cache);
    const response = await cache.match(url);
    if (!response) return null;

    const value: unknown = await response.json();
    if (expectedGeneration !== cacheGeneration) return null;
    if (!Array.isArray(value) || value.length === 0) {
      await cache.delete(url);
      return null;
    }
    return value as T[];
  } catch (error) {
    console.warn("读取照片列表缓存失败:", error);
    return null;
  }
}

export async function writePhotoListCache<T>(
  key: string,
  value: T[],
  expectedGeneration = cacheGeneration,
): Promise<void> {
  const url = cacheUrl(key);
  if (!url) return;

  try {
    await cleanupChain;
    if (expectedGeneration !== cacheGeneration) return;
    const previousWrite = persistentWriteChains.get(key) ?? Promise.resolve();
    const operation = previousWrite.catch(() => undefined).then(async () => {
      if (expectedGeneration !== cacheGeneration) return;
      const cache = await window.caches.open(PHOTO_LIST_CACHE_NAME);
      if (expectedGeneration !== cacheGeneration) return;
      if (value.length === 0) {
        await cache.delete(url);
        return;
      }
      await cache.put(
        url,
        new Response(JSON.stringify(value), {
          headers: {
            "Content-Type": "application/json",
            [CACHED_AT_HEADER]: String(Date.now()),
          },
        }),
      );
      await prunePersistentCache(cache);
    });
    persistentWriteChains.set(key, operation);
    activePersistentWrites.add(operation);
    try {
      await operation;
    } finally {
      activePersistentWrites.delete(operation);
      if (persistentWriteChains.get(key) === operation) persistentWriteChains.delete(key);
    }
  } catch (error) {
    console.warn("写入照片列表缓存失败:", error);
  }
}

/**
 * Clears only authenticated photo data. App-shell and Workbox precache entries
 * remain intact, so logout does not force a full application redownload.
 */
function queueCacheDeletion(cacheNames: readonly string[], clearOwner: boolean): Promise<void> {
  cacheGeneration += 1;
  memoryPhotoLists.clear();
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

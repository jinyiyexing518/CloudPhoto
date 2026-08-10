export const PHOTO_LIST_CACHE_NAME = "cloudphoto-photo-lists-v1";

const PRIVATE_MEDIA_CACHE_NAMES = ["photo-media-v1", "cf-media-v1"] as const;
const PRIVATE_CACHE_NAMES = [PHOTO_LIST_CACHE_NAME, ...PRIVATE_MEDIA_CACHE_NAMES] as const;
const WORKBOX_EXPIRATION_DB_NAME = "workbox-expiration";
const WORKBOX_EXPIRATION_STORE_NAME = "cache-entries";
const CACHE_OWNER_KEY = "cloudphoto_private_cache_owner_v1";
const PRIVATE_LOCAL_DATA_PREFIX = "cloudphoto_private_data_v1:";
const LEGACY_PRIVATE_LOCAL_KEYS = [
  "cloudphoto_moments_insights_v1",
  "cloudphoto_moments_diagnostics_v1",
  "cf_recent_share_links",
] as const;

let cacheGeneration = 0;
let activePrivateCacheOwner: string | null = null;
let cleanupChain: Promise<void> = Promise.resolve();
const activePersistentWrites = new Set<Promise<void>>();
const resetListeners = new Set<(scopeReset: boolean) => void>();

export type PrivateExpirationCleanupResult = {
  status: "deleted" | "unavailable" | "database-absent" | "store-absent" | "error";
  deletedEntries: number;
};

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

function openExistingExpirationDatabase(
  databaseFactory: IDBFactory,
): Promise<IDBDatabase | "database-absent" | "error"> {
  return new Promise((resolve) => {
    let createdDatabase = false;
    let request: IDBOpenDBRequest;
    try {
      request = databaseFactory.open(WORKBOX_EXPIRATION_DB_NAME);
    } catch {
      resolve("error");
      return;
    }
    request.onupgradeneeded = () => {
      createdDatabase = true;
      request.transaction?.abort();
    };
    request.onerror = () => resolve(createdDatabase ? "database-absent" : "error");
    request.onsuccess = () => resolve(request.result);
  });
}

function collectPrivateExpirationKeys(
  database: IDBDatabase,
  privateCacheNames: ReadonlySet<string>,
): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(WORKBOX_EXPIRATION_STORE_NAME, "readonly");
    } catch (error) {
      reject(error);
      return;
    }
    const keys: IDBValidKey[] = [];
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    const request = transaction.objectStore(WORKBOX_EXPIRATION_STORE_NAME).openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(keys);
        return;
      }
      const row = cursor.value;
      if (
        row
        && typeof row === "object"
        && typeof (row as { cacheName?: unknown }).cacheName === "string"
        && privateCacheNames.has((row as { cacheName: string }).cacheName)
      ) {
        keys.push(cursor.primaryKey);
      }
      cursor.continue();
    };
  });
}

function deleteExpirationKeys(
  database: IDBDatabase,
  keys: readonly IDBValidKey[],
): Promise<void> {
  if (keys.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(WORKBOX_EXPIRATION_STORE_NAME, "readwrite");
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    const store = transaction.objectStore(WORKBOX_EXPIRATION_STORE_NAME);
    for (const key of keys) store.delete(key);
  });
}

export async function purgePrivateWorkboxExpirationMetadata(
  databaseFactory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB,
  cacheNames: readonly string[] = PRIVATE_CACHE_NAMES,
): Promise<PrivateExpirationCleanupResult> {
  if (!databaseFactory) return { status: "unavailable", deletedEntries: 0 };

  const databases = (
    databaseFactory as IDBFactory & {
      databases?: () => Promise<Array<{ name?: string }>>;
    }
  ).databases;
  if (typeof databases === "function") {
    try {
      const existing = await databases.call(databaseFactory);
      if (!existing.some((database) => database.name === WORKBOX_EXPIRATION_DB_NAME)) {
        return { status: "database-absent", deletedEntries: 0 };
      }
    } catch {
      // Fall through to a non-versioned open; onupgradeneeded aborts if absent.
    }
  }

  const database = await openExistingExpirationDatabase(databaseFactory);
  if (database === "database-absent" || database === "error") {
    return { status: database, deletedEntries: 0 };
  }
  try {
    if (!database.objectStoreNames.contains(WORKBOX_EXPIRATION_STORE_NAME)) {
      return { status: "store-absent", deletedEntries: 0 };
    }
    const keys = await collectPrivateExpirationKeys(database, new Set(cacheNames));
    await deleteExpirationKeys(database, keys);
    return { status: "deleted", deletedEntries: keys.length };
  } catch {
    return { status: "error", deletedEntries: 0 };
  } finally {
    database.close();
  }
}

function queueCacheDeletion(cacheNames: readonly string[], clearOwner: boolean): Promise<void> {
  cacheGeneration += 1;
  if (clearOwner) activePrivateCacheOwner = null;
  for (const reset of resetListeners) reset(clearOwner);
  if (clearOwner) removePrivateLocalData(true);

  const deletePrivateCaches = async () => {
    for (let pass = 0; pass < 2; pass += 1) {
      await Promise.allSettled([...activePersistentWrites]);
      if (typeof window !== "undefined" && "caches" in window) {
        await Promise.allSettled(cacheNames.map((name) => window.caches.delete(name)));
      }
      await purgePrivateWorkboxExpirationMetadata(undefined, cacheNames);
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
  activePrivateCacheOwner = authScope;
  try {
    localStorage.setItem(CACHE_OWNER_KEY, authScope);
  } catch {
    // Authorization-scoped cache keys still isolate memory and Cache Storage entries.
  }
}

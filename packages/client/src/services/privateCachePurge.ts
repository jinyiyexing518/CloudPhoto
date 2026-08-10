const WORKBOX_EXPIRATION_DB_NAME = "workbox-expiration";
const WORKBOX_EXPIRATION_STORE_NAME = "cache-entries";
const CACHE_OWNER_KEY = "cloudphoto_private_cache_owner_v1";
const LEGACY_PRIVATE_LOCAL_KEYS = [
  "cloudphoto_moments_insights_v1",
  "cloudphoto_moments_diagnostics_v1",
  "cf_recent_share_links",
] as const;

export type PrivateExpirationCleanupResult = {
  status: "deleted" | "unavailable" | "database-absent" | "store-absent";
  deletedEntries: number;
};

function cleanupFailure(step: string, cause: unknown): Error {
  return new Error(`Private Workbox expiration cleanup failed during ${step}`, { cause });
}

export function removeLegacyPrivateLocalData(): void {
  try {
    for (const key of LEGACY_PRIVATE_LOCAL_KEYS) localStorage.removeItem(key);
    localStorage.setItem("cloudphoto_private_cleanup_v1", "1");
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

function openExistingExpirationDatabase(
  databaseFactory: IDBFactory,
): Promise<IDBDatabase | "database-absent"> {
  return new Promise((resolve, reject) => {
    let createdDatabase = false;
    let request: IDBOpenDBRequest;
    try {
      request = databaseFactory.open(WORKBOX_EXPIRATION_DB_NAME);
    } catch (error) {
      reject(cleanupFailure("database open", error));
      return;
    }
    request.onupgradeneeded = () => {
      createdDatabase = true;
      request.transaction?.abort();
    };
    request.onerror = () => {
      if (createdDatabase) {
        resolve("database-absent");
        return;
      }
      reject(cleanupFailure("database open", request.error));
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function collectPrivateExpirationKeys(
  database: IDBDatabase,
  privateCacheNames: ReadonlySet<string>,
): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let request: IDBRequest<IDBCursorWithValue | null>;
    const keys: IDBValidKey[] = [];
    try {
      transaction = database.transaction(WORKBOX_EXPIRATION_STORE_NAME, "readonly");
      request = transaction.objectStore(WORKBOX_EXPIRATION_STORE_NAME).openCursor();
    } catch (error) {
      reject(cleanupFailure("readonly transaction", error));
      return;
    }
    transaction.oncomplete = () => resolve(keys);
    transaction.onerror = () => reject(cleanupFailure("readonly transaction", transaction.error));
    transaction.onabort = () => reject(cleanupFailure("readonly transaction", transaction.error));
    request.onerror = () => reject(cleanupFailure("cursor scan", request.error));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
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
      const store = transaction.objectStore(WORKBOX_EXPIRATION_STORE_NAME);
      for (const key of keys) store.delete(key);
    } catch (error) {
      reject(cleanupFailure("readwrite transaction", error));
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(cleanupFailure("readwrite transaction", transaction.error));
    transaction.onabort = () => reject(cleanupFailure("readwrite transaction", transaction.error));
  });
}

export async function purgePrivateWorkboxExpirationMetadata(
  databaseFactory: IDBFactory | undefined,
  cacheNames: readonly string[],
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
      // A non-versioned open remains authoritative when inventory is unavailable.
    }
  }

  const database = await openExistingExpirationDatabase(databaseFactory);
  if (database === "database-absent") {
    return { status: database, deletedEntries: 0 };
  }
  try {
    if (!database.objectStoreNames.contains(WORKBOX_EXPIRATION_STORE_NAME)) {
      return { status: "store-absent", deletedEntries: 0 };
    }
    const keys = await collectPrivateExpirationKeys(database, new Set(cacheNames));
    await deleteExpirationKeys(database, keys);
    return { status: "deleted", deletedEntries: keys.length };
  } finally {
    database.close();
  }
}

export async function deletePrivateCaches(
  cacheNames: readonly string[],
  activePersistentWrites: ReadonlySet<Promise<void>>,
): Promise<void> {
  removeLegacyPrivateLocalData();
  const failures: unknown[] = [];
  for (let pass = 0; pass < 2; pass += 1) {
    await Promise.allSettled([...activePersistentWrites]);
    if (typeof window !== "undefined" && "caches" in window) {
      const results = await Promise.allSettled(
        cacheNames.map((name) => window.caches.delete(name)),
      );
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
    }
    try {
      await purgePrivateWorkboxExpirationMetadata(
        typeof indexedDB === "undefined" ? undefined : indexedDB,
        cacheNames,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    const details = failures
      .map((failure) => failure instanceof Error ? failure.message : String(failure))
      .join("; ");
    throw new AggregateError(failures, `Private cache cleanup failed: ${details}`);
  }
}

const WORKBOX_EXPIRATION_DB_NAME = "workbox-expiration";
const WORKBOX_EXPIRATION_STORE_NAME = "cache-entries";
const WORKBOX_CACHE_NAME_INDEX = "cacheName";

export type PrivateExpirationCleanupResult = {
  status: "deleted" | "unavailable" | "database-absent" | "store-absent";
  deletedEntries: number;
};

function cleanupFailure(step: string, cause: unknown): Error {
  const error = new Error("本地私有缓存暂不可用", { cause });
  error.name = `PrivateCacheCleanupError (${step})`;
  return error;
}

function openExistingExpirationDatabase(
  databaseFactory: IDBFactory,
): Promise<IDBDatabase | "database-absent"> {
  return new Promise((resolve, reject) => {
    let createdDatabase = false;
    let settled = false;
    let request: IDBOpenDBRequest;
    const resolveOnce = (result: IDBDatabase | "database-absent") => {
      if (settled) {
        if (typeof result !== "string") result.close();
        return;
      }
      settled = true;
      resolve(result);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(cleanupFailure("database open", error));
    };
    try {
      request = databaseFactory.open(WORKBOX_EXPIRATION_DB_NAME);
    } catch (error) {
      rejectOnce(error);
      return;
    }
    request.onupgradeneeded = () => {
      createdDatabase = true;
      try {
        request.transaction?.abort();
      } catch (error) {
        rejectOnce(error);
      }
    };
    request.onblocked = () => rejectOnce(request.error);
    request.onerror = () => {
      if (createdDatabase) resolveOnce("database-absent");
      else rejectOnce(request.error);
    };
    request.onsuccess = () => {
      if (createdDatabase) {
        request.result.close();
        resolveOnce("database-absent");
      } else {
        resolveOnce(request.result);
      }
    };
  });
}

function deletePrivateExpirationRows(
  database: IDBDatabase,
  privateCacheNames: ReadonlySet<string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(WORKBOX_EXPIRATION_STORE_NAME, "readwrite");
    } catch (error) {
      reject(cleanupFailure("readwrite transaction", error));
      return;
    }
    let deletedEntries = 0;
    let settled = false;
    const fail = (step: string, error: unknown) => {
      if (settled) return;
      settled = true;
      reject(cleanupFailure(step, error));
    };
    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(deletedEntries);
    };
    transaction.onerror = () => fail("readwrite transaction", transaction.error);
    transaction.onabort = () => fail("readwrite transaction", transaction.error);

    try {
      const store = transaction.objectStore(WORKBOX_EXPIRATION_STORE_NAME);
      if (!store.indexNames.contains(WORKBOX_CACHE_NAME_INDEX)) {
        throw new Error("cacheName index unavailable");
      }
      const cacheNameIndex = store.index(WORKBOX_CACHE_NAME_INDEX);
      for (const cacheName of privateCacheNames) {
        const request = cacheNameIndex.openKeyCursor(cacheName);
        request.onerror = () => fail("cacheName cursor", request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          try {
            cursor.delete();
            deletedEntries += 1;
            cursor.continue();
          } catch (error) {
            try {
              transaction.abort();
            } catch {
              // The cursor error remains the useful failure.
            }
            fail("cacheName cursor", error);
          }
        };
      }
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The schema error remains the useful failure.
      }
      fail("readwrite transaction", error);
    }
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
    const deletedEntries = await deletePrivateExpirationRows(database, new Set(cacheNames));
    return { status: "deleted", deletedEntries };
  } finally {
    database.close();
  }
}

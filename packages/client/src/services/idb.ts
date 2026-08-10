const WORKBOX_EXPIRATION_DB_NAME = "workbox-expiration";
const WORKBOX_EXPIRATION_STORE_NAME = "cache-entries";

export type PrivateExpirationCleanupResult = {
  status: "deleted" | "unavailable" | "database-absent" | "store-absent" | "error";
  deletedEntries: number;
};

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

export async function purge(
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

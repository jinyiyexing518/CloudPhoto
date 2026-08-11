import {
  getPrivatePhotoCacheGeneration,
  invalidatePrivatePhotoListCacheGeneration,
  registerPrivatePhotoCacheReset,
} from "./privatePhotoCacheLifecycle.ts";

export const PHOTO_LIST_CACHE_NAME = "cloudphoto-photo-lists-v1";

let cleanupChain: Promise<void> = Promise.resolve();
const activeWrites = new Set<Promise<void>>();

registerPrivatePhotoCacheReset((scopeReset) => {
  if (scopeReset) cleanupChain = cleanupChain.then(undefined, () => undefined);
});

export function registerPrivatePhotoListCacheWrite(
  operation: Promise<void>,
): () => void {
  activeWrites.add(operation);
  return () => activeWrites.delete(operation);
}

export function waitForPrivatePhotoListCacheCleanup(): Promise<void> {
  return cleanupChain;
}

export function invalidatePhotoListCaches(): Promise<void> {
  const expectedGeneration = invalidatePrivatePhotoListCacheGeneration();
  const deletePhotoListCache = async () => {
    const reset = await import("./privateCacheReset.ts");
    await reset.resetPrivateCaches(
      [PHOTO_LIST_CACHE_NAME],
      activeWrites,
      false,
      false,
      () => expectedGeneration === getPrivatePhotoCacheGeneration(),
    );
  };
  cleanupChain = cleanupChain.then(deletePhotoListCache, deletePhotoListCache);
  return cleanupChain;
}

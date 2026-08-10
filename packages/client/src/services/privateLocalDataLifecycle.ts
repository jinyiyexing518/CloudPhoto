import {
  getPrivatePhotoCacheOwner,
  registerPrivatePhotoCacheReset,
} from "./privatePhotoCacheLifecycle.ts";

const PRIVATE_CACHE_OWNER_KEY = "cloudphoto_private_cache_owner_v1";
const PRIVATE_LOCAL_DATA_PREFIX = "cloudphoto_private_data_v1:";

export interface PrivateLocalDataContext {
  authScope: string;
  generation: number;
}

export type PrivateLocalDataStorageContextStatus =
  | "current"
  | "stale-context"
  | "storage-unavailable";

let privateLocalDataGeneration = 0;
const resetListeners = new Set<() => void>();

registerPrivatePhotoCacheReset((scopeReset) => {
  if (!scopeReset) return;
  privateLocalDataGeneration += 1;
  for (const listener of resetListeners) listener();
});

export function registerPrivateLocalDataReset(listener: () => void): () => void {
  resetListeners.add(listener);
  return () => resetListeners.delete(listener);
}

export function capturePrivateLocalDataContext(): PrivateLocalDataContext | null {
  const authScope = getPrivatePhotoCacheOwner();
  return authScope
    ? { authScope, generation: privateLocalDataGeneration }
    : null;
}

export function isPrivateLocalDataContextCurrent(
  context: PrivateLocalDataContext | null,
): context is PrivateLocalDataContext {
  return !!context
    && context.generation === privateLocalDataGeneration
    && getPrivatePhotoCacheOwner() === context.authScope;
}

export function getPrivateLocalDataStorageContextStatus(
  context: PrivateLocalDataContext | null,
): PrivateLocalDataStorageContextStatus {
  if (!isPrivateLocalDataContextCurrent(context)) return "stale-context";
  try {
    return localStorage.getItem(PRIVATE_CACHE_OWNER_KEY) === context.authScope
      ? "current"
      : "storage-unavailable";
  } catch {
    return "storage-unavailable";
  }
}

export function isPrivateLocalDataStorageContextCurrent(
  context: PrivateLocalDataContext | null,
): context is PrivateLocalDataContext {
  return getPrivateLocalDataStorageContextStatus(context) === "current";
}

export function privateLocalDataStorageKey(
  context: PrivateLocalDataContext,
  ...segments: string[]
): string {
  return `${PRIVATE_LOCAL_DATA_PREFIX}${[
    context.authScope,
    ...segments,
  ].map(encodeURIComponent).join(":")}`;
}

export { authCacheOwner } from "./authScope";

// Admin personal lists can include other users' photos, so role is part of the
// owner and group is part of every in-memory and persistent list-cache key.
export function privatePhotoListCacheKey(
  groupId: string,
  cacheOwner: string,
): string | null {
  if (!cacheOwner) return null;
  return `auth:${cacheOwner}:group:${groupId || "personal"}`;
}

export const MEDIA_CACHEABLE_RESPONSE_STATUSES = [200] as const;

const CACHEABLE_PHOTO_PATH = /\.(?:bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;

export function isCacheablePhotoPath(pathname: string): boolean {
  return CACHEABLE_PHOTO_PATH.test(pathname);
}

export function isMediaRequestCacheEligible(input: {
  method: string;
  hasRange: boolean;
  isMediaUrl: boolean;
  pathname: string;
}): boolean {
  return input.method.toUpperCase() === "GET"
    && !input.hasRange
    && input.isMediaUrl
    && isCacheablePhotoPath(input.pathname);
}

export function shouldRefreshPhotoList(
  lastRefreshAt: number,
  now = Date.now(),
  minimumIntervalMs = 60_000,
): boolean {
  return now - lastRefreshAt >= minimumIntervalMs;
}

export function canPublishPhotoList(input: {
  expectedOwner: string;
  currentOwner: string | null;
  expectedCacheGeneration: number;
  currentCacheGeneration: number;
  expectedStateRevision?: number;
  currentStateRevision?: number;
}): boolean {
  return input.expectedOwner.length > 0
    && input.currentOwner === input.expectedOwner
    && input.expectedCacheGeneration === input.currentCacheGeneration
    && (
      input.expectedStateRevision === undefined
      || input.currentStateRevision === input.expectedStateRevision
    );
}

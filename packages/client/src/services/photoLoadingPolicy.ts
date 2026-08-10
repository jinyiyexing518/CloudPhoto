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
export const PHOTO_WORKSPACE_POLICY_MARKER = "cloudphoto-photo-workspace-resolved-v1";
export const PHOTO_LIST_BACKGROUND_REFRESH_MS = 5 * 60_000;

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

export function shouldRefreshPhotoWorkspace(input: {
  currentWorkspaceKey: string | null;
  lastWorkspaceKey: string | null;
  lastRefreshAt: number;
  requestInFlight: boolean;
  now?: number;
}): boolean {
  if (!input.currentWorkspaceKey || input.requestInFlight) return false;
  return input.currentWorkspaceKey !== input.lastWorkspaceKey
    || shouldRefreshPhotoList(
      input.lastRefreshAt,
      input.now,
      PHOTO_LIST_BACKGROUND_REFRESH_MS,
    );
}

export function resolvePhotoWorkspaceRequest(input: {
  groupsLoaded: boolean;
  selectionRestored: boolean;
  groupId: string;
}): string | null {
  if (!input.selectionRestored) return null;
  return input.groupId === "" || input.groupsLoaded ? input.groupId : null;
}

export function canExposeWorkspaceSelection(input: {
  userId: string | null;
  selectionOwnerId: string | null;
  selectionRestored: boolean;
}): boolean {
  return input.userId !== null
    && input.selectionOwnerId === input.userId
    && input.selectionRestored;
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

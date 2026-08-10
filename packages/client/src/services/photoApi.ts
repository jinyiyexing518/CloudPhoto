/**
 * Photo API — core photo types + CRUD operations.
 *
 * This is the primary entry point for photo-related data.  For historical
 * import compatibility all symbols from the other service modules are also
 * re-exported from here, so existing `import { ... } from "./photoApi"` calls
 * continue to work without change.
 *
 * New code should import directly from the domain-specific module:
 *   http      → src/services/http.ts       (fetch utilities, token management)
 *   authApi   → src/services/authApi.ts    (login, register, profile)
 *   uploadApi → src/services/uploadApi.ts  (upload with progress, video thumbnail)
 *   shareApi  → src/services/shareApi.ts   (create / manage share links)
 */

import { API_BASE } from "../utils/apiBase";
import {
  authHeaders,
  authHeadersForSnapshot,
  fetchWithTimeout,
  getAuthGeneration,
  getAuthorizationSnapshot,
  parseApiError,
  signalAuthIdentityChange,
  subscribeToAuthChanges,
} from "./http";
import {
  runMaintenanceBackfillPages,
  type MaintenanceBackfillProgress,
} from "./maintenanceBackfillPaging";
import {
  getPrivatePhotoCacheGeneration,
  readMemoryPhotoListCache,
  readPhotoListCache,
  writeMemoryPhotoListCache,
  writePhotoListCache,
} from "./photoListCache";
import {
  canPublishPhotoList,
  privatePhotoListCacheKey,
} from "./photoLoadingPolicy";
import {
  getPreferredMediaUrl,
  routeMediaUrls,
  selectFastestMediaRoute,
  toDirectMediaUrl,
} from "./mediaRoute";
import type { MomentInsight } from "./shareApi";
import { ManagedMomentsUnavailableError } from "./shareApi";
import {
  selectInitialViewerMediaSource,
} from "@cloudphoto/algorithm";

// ── Re-exports for backward compatibility ─────────────────────────────────
export {
  saveStoredAuth, clearStoredAuth, getToken, getTokenAuthScope, getAuthGeneration,
  setUnauthorizedHandler, subscribeToAuthChanges, invalidateAuthRefresh,
  fetchWithTimeout, authHeaders,
} from "./http";
export { authCacheOwner } from "./authScope";
export type { AuthUser, AuthResponse } from "./authApi";
export { loginApi, registerApi, getMeApi, addAdminApi, updateProfileApi, changePasswordApi } from "./authApi";
export {
  AuthSessionChangedError,
  uploadPhoto,
  uploadPhotoWithProgress,
  extractVideoThumbnail,
  persistVideoPlaybackThumbnail,
  setVideoThumbnail,
} from "./uploadApi";
export type { ManagedShareLink, MomentInsight } from "./shareApi";
export { ManagedMomentsUnavailableError, createPhotoShareLink, createFolderShareLink, listManagedShareLinks, updateManagedShareLink } from "./shareApi";

// ── Photo domain type ─────────────────────────────────────────────────────
export interface Photo {
  name: string; originalName?: string; subject?: string; favorite?: boolean;
  folder?: string; groupId?: string; url: string;
  thumbnailUrl?: string; previewUrl?: string;
  size: number; lastModified: string; contentType: string;
  createdAt?: string; createdBy?: string;
  lastModifiedAt?: string; lastModifiedBy?: string;
  deletedAt?: string; deletedBy?: string; deletedByName?: string;
  voiceMemoName?: string; voiceMemoUrl?: string;
  gpsLat?: string; gpsLon?: string;
  isAnimated?: boolean;
  takenAt?: string;
}

export interface MotionVideoResult {
  url: string | null; error: string | null; reason: string | null;
}

export interface PhotoLocation {
  name: string; lat: number; lon: number; originalName?: string; contentType?: string;
}

function isPhotoPayload(value: unknown): value is Photo {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Photo>;
  const optionalUrls = [
    candidate.thumbnailUrl,
    candidate.previewUrl,
    candidate.voiceMemoUrl,
  ];
  return typeof candidate.name === "string"
    && candidate.name.length > 0
    && typeof candidate.url === "string"
    && candidate.url.length > 0
    && optionalUrls.every((url) => url === undefined || typeof url === "string");
}

function parsePhotoListPayload(value: unknown): Photo[] {
  if (!Array.isArray(value) || !value.every(isPhotoPayload)) {
    throw new Error("Invalid photo-list response");
  }
  return value;
}

// ── Adaptive Blob routing ─────────────────────────────────────────────────
export function proxyBlobUrl(url: string): string {
  return getPreferredMediaUrl(url);
}

export function proxyPhoto(photo: Photo): Photo {
  const routed = routeMediaUrls(photo);
  return {
    ...photo,
    ...routed,
  };
}

export function getViewerSrc(photo: Photo): string {
  return getPreferredMediaUrl(selectInitialViewerMediaSource({
    originalUrl: photo.url,
    thumbnailUrl: photo.thumbnailUrl,
    previewUrl: photo.previewUrl,
    viewportWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio || 1,
  }));
}

// ── Motion video ──────────────────────────────────────────────────────────
export async function fetchMotionVideoBlob(photoName: string): Promise<MotionVideoResult> {
  const url = `${API_BASE}/photos/motion-video?name=${encodeURIComponent(photoName)}`;
  const res = await fetchWithTimeout(url, { headers: authHeaders() }, 30_000).catch(() => null);
  if (!res) return { url: null, error: "网络请求失败，请重试", reason: "network-error" };
  if (res.ok) { const blob = await res.blob(); return { url: URL.createObjectURL(blob), error: null, reason: null }; }
  try {
    const body = await res.json() as { error?: string; reason?: string };
    return { url: null, error: body.error ?? "动态视频提取失败", reason: body.reason ?? null };
  } catch { return { url: null, error: "动态视频提取失败", reason: null }; }
}

// ── Photo list SWR cache ──────────────────────────────────────────────────
export class AuthorizationDriftError extends Error {
  constructor() {
    super("Authorization identity changed");
    this.name = "AuthorizationDriftError";
  }
}

export function isAuthorizationDriftError(error: unknown): boolean {
  return error instanceof AuthorizationDriftError;
}

function assertAuthorizationOwner(expectedOwner: string) {
  const snapshot = getAuthorizationSnapshot();
  if (!snapshot || snapshot.cacheOwner !== expectedOwner) {
    signalAuthIdentityChange();
    throw new AuthorizationDriftError();
  }
  return snapshot;
}

const MEDIA_URL_REUSE_MIN_MS = 10 * 60 * 1000;
type PhotoMediaUrlKey = "url" | "thumbnailUrl" | "previewUrl" | "voiceMemoUrl";
const PHOTO_MEDIA_URL_KEYS: PhotoMediaUrlKey[] = [
  "url",
  "thumbnailUrl",
  "previewUrl",
  "voiceMemoUrl",
];

function mediaResourcePath(url: string): string | null {
  try {
    return new URL(toDirectMediaUrl(url), window.location.origin).pathname;
  } catch {
    return null;
  }
}

function sasExpiry(url: string): number | null {
  try {
    const expiresAt = Date.parse(new URL(url, window.location.origin).searchParams.get("se") ?? "");
    return Number.isFinite(expiresAt) ? expiresAt : null;
  } catch {
    return null;
  }
}

export function selectFresherMediaUrl(
  currentUrl: string | undefined,
  candidateUrl: string,
): string {
  if (!currentUrl || mediaResourcePath(currentUrl) !== mediaResourcePath(candidateUrl)) {
    return candidateUrl;
  }
  const currentExpiry = sasExpiry(currentUrl);
  const candidateExpiry = sasExpiry(candidateUrl);
  return currentExpiry !== null
    && candidateExpiry !== null
    && currentExpiry > candidateExpiry
    ? currentUrl
    : candidateUrl;
}

function reuseFreshMediaUrls(next: Photo, previous: Photo | undefined): Photo {
  if (!previous) return next;
  const merged = { ...next };
  for (const key of PHOTO_MEDIA_URL_KEYS) {
    const previousUrl = previous[key];
    const nextUrl = next[key];
    const previousExpiry = previousUrl ? sasExpiry(previousUrl) : null;
    const nextExpiry = nextUrl ? sasExpiry(nextUrl) : null;
    if (
      previousUrl
      && nextUrl
      && previousExpiry !== null
      && nextExpiry !== null
      && previousExpiry - Date.now() > MEDIA_URL_REUSE_MIN_MS
      && previousExpiry >= nextExpiry
      && mediaResourcePath(previousUrl) === mediaResourcePath(nextUrl)
    ) {
      merged[key] = previousUrl;
    }
  }
  return merged;
}

/** Returns the in-memory photo list for a user/group (may be stale). */
export function getCachedPhotos(groupId = "", cacheScope = ""): Photo[] | null {
  const key = privatePhotoListCacheKey(groupId, cacheScope);
  if (!key || getAuthorizationSnapshot()?.cacheOwner !== cacheScope) {
    if (cacheScope) signalAuthIdentityChange();
    return null;
  }
  return readMemoryPhotoListCache<Photo>(key);
}

/** Restores a recent photo list from Cache Storage after a page reload. */
export async function getPersistedPhotos(
  groupId = "",
  cacheScope = "",
  isCurrent?: () => boolean,
): Promise<Photo[] | null> {
  const key = privatePhotoListCacheKey(groupId, cacheScope);
  if (!key) return null;
  assertAuthorizationOwner(cacheScope);
  const cacheGeneration = getPrivatePhotoCacheGeneration();
  const memory = readMemoryPhotoListCache<Photo>(key);
  if (memory) {
    assertAuthorizationOwner(cacheScope);
    return isCurrent?.() === false ? null : memory;
  }

  const cached = await readPhotoListCache<unknown>(key, cacheGeneration);
  assertAuthorizationOwner(cacheScope);
  if (
    isCurrent?.() === false
    || cacheGeneration !== getPrivatePhotoCacheGeneration()
  ) {
    return null;
  }
  if (cached && !cached.every(isPhotoPayload)) {
    await writePhotoListCache(key, [], cacheGeneration);
    return null;
  }
  const photos = cached?.map(proxyPhoto) ?? null;
  if (photos) writeMemoryPhotoListCache(key, photos);
  return photos;
}

// ── Photo list ────────────────────────────────────────────────────────────
interface ListPhotosOptions {
  cacheScope?: string;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export async function listPhotos(groupId = "", options: ListPhotosOptions = {}): Promise<Photo[]> {
  const expectedOwner = options.cacheScope ?? "";
  const authorization = assertAuthorizationOwner(expectedOwner);
  const cacheGeneration = getPrivatePhotoCacheGeneration();
  const url = groupId ? `${API_BASE}/photos?groupId=${encodeURIComponent(groupId)}` : `${API_BASE}/photos`;
  const response = await fetchWithTimeout(
    url,
    { headers: authHeadersForSnapshot(authorization), signal: options.signal },
    45_000,
  );
  if (!response.ok) throw new Error("Failed to fetch photos");
  const rawPhotos = parsePhotoListPayload(await response.json() as unknown);
  assertAuthorizationOwner(expectedOwner);
  if (options.isCurrent?.() === false) throw new AuthorizationDriftError();
  const currentOwner = getAuthorizationSnapshot()?.cacheOwner ?? null;
  if (!canPublishPhotoList({
    expectedOwner,
    currentOwner,
    expectedCacheGeneration: cacheGeneration,
    currentCacheGeneration: getPrivatePhotoCacheGeneration(),
  }) || options.isCurrent?.() === false) {
    if (currentOwner !== expectedOwner) signalAuthIdentityChange();
    throw new AuthorizationDriftError();
  }
  const key = privatePhotoListCacheKey(groupId, expectedOwner);
  const previousPhotos = key ? readMemoryPhotoListCache<Photo>(key) : null;
  const previousByName = new Map(previousPhotos?.map((photo) => [photo.name, photo]));
  const photos = rawPhotos
    .map(proxyPhoto)
    .map((photo) => reuseFreshMediaUrls(photo, previousByName.get(photo.name)));
  const routeProbeSample = photos.find((photo) => photo.thumbnailUrl || photo.previewUrl);
  void selectFastestMediaRoute(routeProbeSample?.thumbnailUrl ?? routeProbeSample?.previewUrl);
  if (key) {
    writeMemoryPhotoListCache(key, photos);
    void writePhotoListCache(key, photos, cacheGeneration);
  }
  return photos;
}

export async function fetchPhotoLocations(groupId = ""): Promise<PhotoLocation[]> {
  const url = groupId ? `${API_BASE}/photos/locations?groupId=${encodeURIComponent(groupId)}` : `${API_BASE}/photos/locations`;
  try {
    const response = await fetchWithTimeout(url, { headers: authHeaders() });
    if (!response.ok) return [];
    return response.json() as Promise<PhotoLocation[]>;
  } catch { return []; }
}

// ── Photo metadata mutations (consolidated via shared patchMetadata) ───────
async function patchMetadata(name: string, patch: Record<string, unknown>, errorMsg: string): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/metadata?name=${encodeURIComponent(name)}`,
    { method: "PATCH", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(patch) },
  );
  if (!response.ok) throw new Error(await parseApiError(response, errorMsg));
}

export const updatePhotoSubject  = (name: string, subject: string, updatedBy?: string) => patchMetadata(name, { subject, updatedBy }, "更新主题失败");
export const setPhotoFavorite    = (name: string, favorite: boolean, updatedBy?: string) => patchMetadata(name, { favorite, updatedBy }, "更新收藏状态失败");
export const setPhotoVoiceMemo   = (name: string, voiceMemoName: string, updatedBy?: string) => patchMetadata(name, { voiceMemoName, updatedBy }, "更新语音备注失败");
export const updatePhotoGps      = (name: string, gpsLat: string, gpsLon: string) => patchMetadata(name, { gpsLat, gpsLon }, "更新位置失败");
export const updatePhotoTakenAt  = (name: string, takenAt: string, updatedBy?: string) => patchMetadata(name, { takenAt, updatedBy }, "更新拍摄时间失败");
export const renamePhoto         = (name: string, newOriginalName: string, updatedBy?: string) => patchMetadata(name, { originalName: newOriginalName, updatedBy }, "重命名照片失败");

// ── Photo operations ──────────────────────────────────────────────────────
export async function deletePhoto(name: string): Promise<void> {
  const response = await fetchWithTimeout(`${API_BASE}/photos?name=${encodeURIComponent(name)}`, { method: "DELETE", headers: authHeaders() });
  if (!response.ok) throw new Error(await parseApiError(response, "删除照片失败"));
}

export async function movePhotoToFolder(name: string, toFolder: string, movedBy?: string): Promise<{ newName: string }> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/move`,
    { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ name, toFolder, updatedBy: movedBy }) },
    30_000,
  ).catch((e: unknown) => { throw new Error(e instanceof Error && e.name === "AbortError" ? "移动超时" : "网络错误"); });
  if (!response.ok) throw new Error(await parseApiError(response, "移动照片失败"));
  return response.json() as Promise<{ newName: string }>;
}

interface DownloadTicket {
  url: string;
  filename: string;
  expiresAt: number | null;
}

export const DOWNLOAD_TICKET_CACHE_MAX = 8;
const DOWNLOAD_TICKET_MIN_REUSE_MS = 5 * 60 * 1000;
const downloadTicketCache = new Map<string, Promise<DownloadTicket>>();
subscribeToAuthChanges(() => downloadTicketCache.clear());

function downloadTicketKey(name: string, filename: string, generation: number): string {
  return `${generation}\n${name}\n${filename}`;
}

async function requestDownloadTicket(name: string, filename: string): Promise<DownloadTicket> {
  const generation = getAuthGeneration();
  const params = new URLSearchParams({ name });
  params.set("filename", filename);
  const res = await fetchWithTimeout(
    `${API_BASE}/photos/download?${params}`,
    { headers: authHeaders() },
    15_000,
  );
  if (generation !== getAuthGeneration()) throw new AuthorizationDriftError();
  if (!res.ok) throw new Error(await parseApiError(res, "Download failed"));
  const ticket = await res.json() as { url?: unknown; filename?: unknown };
  if (generation !== getAuthGeneration()) throw new AuthorizationDriftError();
  if (typeof ticket.url !== "string" || !ticket.url) {
    throw new Error("Invalid download ticket");
  }
  return {
    url: ticket.url,
    filename: typeof ticket.filename === "string" && ticket.filename
      ? ticket.filename
      : filename,
    expiresAt: sasExpiry(ticket.url) ?? Date.now() + 50 * 60 * 1000,
  };
}

async function getDownloadTicket(name: string, filename: string): Promise<DownloadTicket> {
  const generation = getAuthGeneration();
  const key = downloadTicketKey(name, filename, generation);
  const cached = downloadTicketCache.get(key);
  if (cached) {
    const ticket = await cached;
    if (
      generation === getAuthGeneration()
      && (ticket.expiresAt === null || ticket.expiresAt - Date.now() > DOWNLOAD_TICKET_MIN_REUSE_MS)
    ) {
      downloadTicketCache.delete(key);
      downloadTicketCache.set(key, cached);
      return ticket;
    }
    downloadTicketCache.delete(key);
  }

  const pending = requestDownloadTicket(name, filename);
  downloadTicketCache.set(key, pending);
  while (downloadTicketCache.size > DOWNLOAD_TICKET_CACHE_MAX) {
    const oldestKey = downloadTicketCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    downloadTicketCache.delete(oldestKey);
  }
  try {
    return await pending;
  } catch (error) {
    if (downloadTicketCache.get(key) === pending) downloadTicketCache.delete(key);
    throw error;
  }
}

export async function preloadPhotoDownload(name: string, filename: string): Promise<void> {
  await getDownloadTicket(name, filename);
}

export async function downloadPhotoApi(name: string, filename: string): Promise<void> {
  const ticket = await getDownloadTicket(name, filename);
  const downloadUrl = getPreferredMediaUrl(ticket.url);

  // Trigger the browser's native download — no file data passes through JS memory.
  // The download bar appears immediately; user can navigate away while it runs.
  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = ticket.filename; // hint for same-origin; Content-Disposition handles cross-origin
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Trash ──────────────────────────────────────────────────────────────────
export async function listTrashPhotos(groupId = ""): Promise<Photo[]> {
  const url = groupId ? `${API_BASE}/photos/trash?groupId=${encodeURIComponent(groupId)}` : `${API_BASE}/photos/trash`;
  const response = await fetchWithTimeout(url, { headers: authHeaders() });
  if (!response.ok) throw new Error("Failed to fetch trash");
  return parsePhotoListPayload(await response.json() as unknown).map(proxyPhoto);
}

export async function restorePhoto(name: string): Promise<void> {
  const response = await fetchWithTimeout(`${API_BASE}/photos/trash/restore?name=${encodeURIComponent(name)}`, { method: "POST", headers: authHeaders() });
  if (!response.ok) throw new Error(await parseApiError(response, "恢复照片失败"));
}

export async function permanentlyDeletePhoto(name: string): Promise<void> {
  const response = await fetchWithTimeout(`${API_BASE}/photos/trash?name=${encodeURIComponent(name)}`, { method: "DELETE", headers: authHeaders() });
  if (!response.ok) throw new Error(await parseApiError(response, "彻底删除照片失败"));
}

// ── Backfill ──────────────────────────────────────────────────────────────
export interface PhotoMetadataBackfillProgress {
  processed: number;
  updated: number;
  failed: number;
  hasMore: boolean;
}

export interface ThumbnailBackfillProgress {
  processed: number;
  generated: number;
  skipped: number;
  failed: number;
  hasMore: boolean;
}

export interface PhotoMetadataBackfillOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PhotoMetadataBackfillProgress) => void;
}

export interface ThumbnailBackfillOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ThumbnailBackfillProgress) => void;
}

export async function backfillPhotoMetadata(
  groupId = "",
  options: PhotoMetadataBackfillOptions = {},
): Promise<{ processed: number; updated: number; failed: number }> {
  const authGeneration = getAuthGeneration();
  const assertCurrentAuth = () => {
    if (authGeneration !== getAuthGeneration()) {
      throw new Error("登录状态已变更，照片元数据回填已停止");
    }
  };
  const totals = await runMaintenanceBackfillPages({
    signal: options.signal,
    paginationError: "照片元数据回填未能继续分页",
    requestPage: async (cursor, signal) => {
      assertCurrentAuth();
      const qp = new URLSearchParams();
      if (groupId) qp.set("groupId", groupId);
      qp.set("limit", "30");
      if (cursor) qp.set("cursor", cursor);
      const response = await fetchWithTimeout(
        `${API_BASE}/photos/backfill?${qp}`,
        { method: "POST", headers: authHeaders(), signal },
        120_000,
      );
      if (authGeneration !== getAuthGeneration()) {
        await response.body?.cancel();
        assertCurrentAuth();
      }
      if (!response.ok) throw new Error(await parseApiError(response, "回填历史照片元数据失败"));
      const result = await response.json() as {
        processed: number;
        updated: number;
        failed: number;
        hasMore: boolean;
        cursor?: string;
      };
      assertCurrentAuth();
      return { ...result, changed: result.updated, skipped: 0 };
    },
    onProgress: (progress: MaintenanceBackfillProgress) => {
      options.onProgress?.({
        processed: progress.processed,
        updated: progress.changed,
        failed: progress.failed,
        hasMore: progress.hasMore,
      });
    },
  });
  return { processed: totals.processed, updated: totals.changed, failed: totals.failed };
}

export async function backfillThumbnails(
  groupId = "",
  options: ThumbnailBackfillOptions = {},
): Promise<{ processed: number; generated: number; skipped: number; failed: number }> {
  const authGeneration = getAuthGeneration();
  const assertCurrentAuth = () => {
    if (authGeneration !== getAuthGeneration()) {
      throw new Error("登录状态已变更，缩略图回填已停止");
    }
  };
  const totals = await runMaintenanceBackfillPages({
    signal: options.signal,
    paginationError: "缩略图回填未能继续分页",
    requestPage: async (cursor, signal) => {
      assertCurrentAuth();
      const qp = new URLSearchParams();
      if (groupId) qp.set("groupId", groupId);
      qp.set("limit", "30");
      if (cursor) qp.set("cursor", cursor);
      const response = await fetchWithTimeout(
        `${API_BASE}/photos/backfill-thumbnails?${qp}`,
        { method: "POST", headers: authHeaders(), signal },
        120_000,
      );
      if (authGeneration !== getAuthGeneration()) {
        await response.body?.cancel();
        assertCurrentAuth();
      }
      if (!response.ok) throw new Error(await parseApiError(response, "缩略图回填失败"));
      const result = await response.json() as {
        processed: number;
        generated: number;
        skipped: number;
        failed: number;
        hasMore: boolean;
        cursor?: string;
      };
      assertCurrentAuth();
      return { ...result, changed: result.generated };
    },
    onProgress: (progress: MaintenanceBackfillProgress) => {
      options.onProgress?.({
        processed: progress.processed,
        generated: progress.changed,
        skipped: progress.skipped,
        failed: progress.failed,
        hasMore: progress.hasMore,
      });
    },
  });
  return {
    processed: totals.processed,
    generated: totals.changed,
    skipped: totals.skipped,
    failed: totals.failed,
  };
}

// ── Folder operations ─────────────────────────────────────────────────────
export async function renameFolderApi(
  oldFolder: string,
  newFolder: string,
  groupId?: string,
): Promise<{ renamed: number }> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/folder`,
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ oldFolder, newFolder, groupId }),
    },
    60_000,
  );
  if (!response.ok) throw new Error(await parseApiError(response, "重命名文件夹失败"));
  return response.json() as Promise<{ renamed: number }>;
}

// ── Moment insights ───────────────────────────────────────────────────────
/** Bulk-fetch moment insight records (view counts etc.) for a list of photos. */
export async function listMomentInsights(
  photoNames: string[],
): Promise<Record<string, MomentInsight>> {
  type InsightsBody = { items: MomentInsight[]; managedUnavailable?: boolean; message?: string };
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/moments/insights`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ photoNames }),
    },
  );
  if (!response.ok) throw new Error(await parseApiError(response, "加载浏览统计失败"));
  const body = await response.json() as InsightsBody;
  if (body.managedUnavailable) {
    // re-use the well-known error class from shareApi so callers can instanceof-check
    throw new ManagedMomentsUnavailableError(body.message ?? "Moments unavailable");
  }
  const map: Record<string, MomentInsight> = {};
  for (const item of body.items ?? []) {
    if (item.photoName) map[item.photoName] = item;
  }
  return map as Record<string, MomentInsight>;
}

/** Record a single photo view for the current user and return the updated insight. */
export async function recordMomentViewApi(
  photoName: string,
  viewerName?: string,
): Promise<MomentInsight | null> {
  type RecordBody = { ok: boolean; item?: MomentInsight; managedUnavailable?: boolean; message?: string };
  try {
    const response = await fetchWithTimeout(
      `${API_BASE}/photos/moments/view`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ photoName, viewerName }),
      },
    );
    if (!response.ok) {
      if (response.status === 503 || response.status === 404) return null;
      throw new Error(await parseApiError(response, "记录浏览失败"));
    }
    const body = await response.json() as RecordBody;
    if (body.managedUnavailable) throw new ManagedMomentsUnavailableError(body.message ?? "Moments unavailable");
    return body.item ?? null;
  } catch (err) {
    if (err instanceof ManagedMomentsUnavailableError) throw err;
    return null;
  }
}

// ── Changelog ─────────────────────────────────────────────────────────────
export interface ChangelogEntry {
  id: string; date: string; icon: string; title: string; desc: string; details?: string;
  type?: "feature" | "fix" | "improvement";
}

export async function fetchChangelogs(days = 7): Promise<ChangelogEntry[]> {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split("T")[0];
  const filterByDate = (list: ChangelogEntry[]) => list.filter((e) => e.date >= cutoffStr);
  try {
    const response = await fetchWithTimeout(`${API_BASE}/changelogs?days=${days}`, { method: "GET", headers: { "Content-Type": "application/json" } });
    if (!response.ok) throw new Error(response.statusText);
    return (await response.json()) as ChangelogEntry[];
  } catch {
    try { const res = await fetch("/changelog.json"); if (!res.ok) return []; return filterByDate((await res.json()) as ChangelogEntry[]); }
    catch { return []; }
  }
}